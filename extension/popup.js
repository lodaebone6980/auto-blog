const DEFAULT_API = 'https://web-production-184ff.up.railway.app';

const STEPS = [
  ['login', '네이버 로그인 확인', '현재 Chrome 세션의 네이버 로그인을 확인합니다.'],
  ['channel', '채널/카테고리 확인', '블로그 URL과 카테고리 후보를 감지해 서버에 저장합니다.'],
  ['claim', '선택 작업 준비', '발행 생성 작업 목록에서 체크한 글을 준비합니다.'],
  ['images', '이미지 불러오기', '서버에 저장된 500x500 이미지 초안을 확인합니다.'],
  ['editor', '작성창 이동', '선택 계정의 플랫폼 작성 화면을 엽니다.'],
  ['insert', '원고 삽입', '현재 작성 화면에 제목과 본문을 삽입합니다.'],
  ['publish', '발행 완료 저장', '발행 URL과 상태를 서버에 저장합니다.'],
];

const state = {
  apiBase: DEFAULT_API,
  accounts: [],
  selectedAccountId: '',
  jobs: [],
  selectedJobIds: [],
  activeJob: null,
  images: [],
  batchRunning: false,
  batchDelaySeconds: 60,
  loggedIn: false,
  steps: {},
};

const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

function apiUrl(path) {
  return `${state.apiBase.replace(/\/$/, '')}/api${path}`;
}

async function api(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `API ${res.status}`);
  return data;
}

function chromePromise(fn) {
  return new Promise((resolve, reject) => {
    try {
      fn((result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function absoluteApiAssetUrl(url = '') {
  if (!url) return '';
  if (/^https?:\/\//i.test(url) || /^data:/i.test(url)) return url;
  if (url.startsWith('/')) return `${state.apiBase.replace(/\/$/, '')}${url}`;
  return url;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeEditorJob(job = {}) {
  const keyword = job.keyword || job.target_keyword || '';
  const plainText = job.plainText || job.plain_text || job.body || '';
  const ctaUrl = job.ctaUrl || job.cta_url || '';
  const qrTargetUrl = job.qrTargetUrl || job.qr_target_url || ctaUrl;
  return {
    ...job,
    keyword,
    plainText,
    plain_text: plainText,
    ctaUrl,
    cta_url: ctaUrl,
    qrTargetUrl,
    qr_target_url: qrTargetUrl,
    platform: job.platform || 'blog',
  };
}

function setStep(key, status, note = '') {
  state.steps[key] = { status, note };
  renderSteps();
}

function resetSteps() {
  state.steps = {};
  renderSteps();
}

function renderSteps() {
  const done = STEPS.filter(([key]) => state.steps[key]?.status === 'done').length;
  const percent = Math.round((done / STEPS.length) * 100);
  $('progressBar').style.width = `${percent}%`;
  setText('progressText', `${percent}%`);
  $('steps').innerHTML = STEPS.map(([key, title, desc], index) => {
    const step = state.steps[key] || {};
    const klass = step.status === 'done' ? 'done' : step.status === 'error' ? 'error' : step.status === 'active' ? 'active-step' : '';
    const mark = step.status === 'done' ? '✓' : step.status === 'error' ? '!' : index + 1;
    const note = step.note || desc;
    return `<li class="${klass}"><span class="dot">${mark}</span><span><strong>${title}</strong><br><span class="muted">${note}</span></span></li>`;
  }).join('');
}

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.panel !== name));
}

async function loadSettings() {
  const saved = await chromePromise((done) => chrome.storage.local.get(['apiBase', 'selectedAccountId', 'selectedJobIds', 'activeJob', 'images', 'batchDelaySeconds'], done));
  state.apiBase = saved.apiBase || DEFAULT_API;
  state.selectedAccountId = saved.selectedAccountId || '';
  state.selectedJobIds = Array.isArray(saved.selectedJobIds) ? saved.selectedJobIds.map((id) => Number(id)).filter(Boolean) : [];
  state.activeJob = saved.activeJob || null;
  state.images = saved.images || [];
  state.batchDelaySeconds = clampNumber(saved.batchDelaySeconds, 5, 600, 60);
  $('apiBase').value = state.apiBase;
  if ($('batchDelaySeconds')) $('batchDelaySeconds').value = state.batchDelaySeconds;
}

async function saveSettings() {
  state.apiBase = $('apiBase').value.trim() || DEFAULT_API;
  await chromePromise((done) => chrome.storage.local.set({ apiBase: state.apiBase }, done));
  setText('loginText', '서버 URL을 저장했습니다.');
  await loadAccounts();
}

async function saveBatchDelaySeconds() {
  state.batchDelaySeconds = clampNumber($('batchDelaySeconds')?.value, 5, 600, 60);
  if ($('batchDelaySeconds')) $('batchDelaySeconds').value = state.batchDelaySeconds;
  await chromePromise((done) => chrome.storage.local.set({ batchDelaySeconds: state.batchDelaySeconds }, done));
  return state.batchDelaySeconds;
}

async function checkNaverLogin(updateServer = false) {
  setStep('login', 'active', '네이버 로그인 쿠키를 확인하는 중입니다.');
  const cookies = await chromePromise((done) => chrome.cookies.getAll({ domain: '.naver.com' }, done)).catch(() => []);
  const loggedIn = cookies.some((cookie) => ['NID_AUT', 'NID_SES'].includes(cookie.name) && cookie.value);
  state.loggedIn = loggedIn;
  const badge = $('loginBadge');
  badge.textContent = loggedIn ? '로그인됨' : '로그인 필요';
  badge.className = `badge ${loggedIn ? 'ok' : 'fail'}`;
  setText('loginText', loggedIn ? '현재 Chrome 네이버 세션이 확인되었습니다.' : '네이버 로그인이 필요합니다.');
  setStep('login', loggedIn ? 'done' : 'error', loggedIn ? '네이버 세션 확인 완료' : '네이버 로그인 후 다시 확인하세요.');
  if (updateServer && selectedAccount()) {
    await updateLoginStatus(selectedAccount(), loggedIn ? '확장 로그인 확인 완료' : '확장 로그인 필요');
  }
  return loggedIn;
}

async function getActiveTab() {
  const tabs = await chromePromise((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
  return tabs?.[0] || null;
}

function blogUrlFromLocation(url = '') {
  try {
    const parsed = new URL(url);
    if (!/blog\.naver\.com$/i.test(parsed.hostname) && !/m\.blog\.naver\.com$/i.test(parsed.hostname)) return '';
    const queryBlogId = parsed.searchParams.get('blogId');
    if (queryBlogId) return `https://blog.naver.com/${queryBlogId}`;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const blogId = parts.find((part) => !['PostView.naver', 'PostList.naver', 'PostWriteForm.naver', 'MyBlog.naver'].includes(part));
    return blogId ? `https://blog.naver.com/${blogId}` : '';
  } catch {
    return '';
  }
}

function candidateChannelUrl(account) {
  if (account?.targetUrl) return account.targetUrl;
  const discoveredUrl = account?.channelDiscovery?.channelUrl;
  if (discoveredUrl) return discoveredUrl;
  const username = String(account?.usernameHint || '').replace(/@naver\.com$/i, '').trim();
  if (account?.platform === 'blog') return 'https://blog.naver.com/MyBlog.naver';
  if (account?.platform === 'cafe') return accountTarget(account);
  if (account?.platform === 'premium') return 'https://contents.premium.naver.com';
  if (account?.platform === 'brunch' && username) return `https://brunch.co.kr/@${username}`;
  return accountTarget(account);
}

async function waitForTabComplete(tabId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chromePromise((done) => chrome.tabs.get(tabId, done)).catch(() => null);
    if (tab?.status === 'complete') return tab;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return chromePromise((done) => chrome.tabs.get(tabId, done)).catch(() => null);
}

async function clickWriteButtonInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textMatches = (text = '') => /^(글쓰기|글 쓰기|새 글쓰기|새글쓰기|포스트쓰기|포스트 쓰기|작성하기)$/.test(text.replace(/\s+/g, ' ').trim());
      const selectors = ['a[href*="PostWriteForm.naver"]', 'a[href*="postwrite"]', 'a[href*="Write"]', 'button', '[role="button"]', 'a'];
      for (const selector of selectors) {
        const node = Array.from(document.querySelectorAll(selector))
          .filter(visible)
          .find((item) => {
            const href = item.getAttribute?.('href') || '';
            const text = item.textContent || item.getAttribute?.('aria-label') || item.getAttribute?.('title') || '';
            return /PostWriteForm\.naver|postwrite|Write/i.test(href) || textMatches(text);
          });
        if (node) {
          const href = node.getAttribute?.('href') || '';
          node.scrollIntoView?.({ block: 'center', inline: 'center' });
          node.click();
          if (href && !href.startsWith('javascript:')) {
            setTimeout(() => { location.href = href; }, 150);
          }
          return { ok: true, href, text: node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || '' };
        }
      }
      return { ok: false };
    },
  }).catch(() => []);
  return results.find((item) => item.result?.ok)?.result || { ok: false };
}

async function detectChannelInTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: 'NAVIWRITE_DETECT_CHANNEL' }).catch((err) => ({
    ok: false,
    error: err.message,
  }));
}

function renderCategoryBox(account = selectedAccount()) {
  const box = $('categoryBox');
  const categories = account?.categories || account?.channelDiscovery?.categories || [];
  if (!categories.length) {
    box.textContent = '카테고리 후보는 채널 확인 후 표시됩니다.';
    return;
  }
  box.innerHTML = categories
    .slice(0, 20)
    .map((category) => `<span class="category-chip">${escapeHtml(category.name || category.label || category.text || category)}</span>`)
    .join('');
}

async function discoverChannel() {
  const account = selectedAccount();
  if (!account) throw new Error('계정 슬롯이 없습니다.');
  setStep('channel', 'active', '블로그 URL과 카테고리 후보를 확인하는 중입니다.');

  let tab = await getActiveTab();
  let targetUrl = blogUrlFromLocation(tab?.url || '') || account.targetUrl || '';

  if (!targetUrl) {
    targetUrl = candidateChannelUrl(account);
    tab = await chrome.tabs.create({ url: targetUrl, active: true });
    tab = await waitForTabComplete(tab.id);
  }

  let detected = tab?.id ? await detectChannelInTab(tab.id) : { ok: false };
  if (!detected?.ok && targetUrl) {
    const opened = await chrome.tabs.create({ url: targetUrl, active: true });
    tab = await waitForTabComplete(opened.id);
    detected = await detectChannelInTab(tab.id);
  }

  const channelUrl = detected?.channelUrl || blogUrlFromLocation(tab?.url || '') || targetUrl;
  const channelDiscovery = {
    ok: Boolean(channelUrl),
    source: detected?.ok ? 'extension_content_script' : 'extension_url_guess',
    channelUrl,
    pageTitle: detected?.pageTitle || tab?.title || '',
    categories: detected?.categories || [],
    detectedAt: new Date().toISOString(),
  };

  await api('/account-slots', {
    method: 'POST',
    body: JSON.stringify({
      slotId: account.id,
      platform: account.platform,
      label: account.label,
      usernameHint: account.usernameHint,
      targetUrl: channelUrl,
      loginStatus: account.loginStatus || '확장 로그인 확인 완료',
      channelDiscovery,
    }),
  });
  await loadAccounts();
  renderCategoryBox();
  setStep('channel', channelUrl ? 'done' : 'error', channelUrl ? `${channelUrl} 저장 완료` : '채널 URL을 확인하지 못했습니다.');
}

async function loadAccounts() {
  const data = await api('/account-slots');
  state.accounts = data.accounts || [];
  if (!state.selectedAccountId && state.accounts[0]) state.selectedAccountId = state.accounts[0].id;
  await chromePromise((done) => chrome.storage.local.set({ selectedAccountId: state.selectedAccountId }, done));
  renderAccounts();
}

function selectedAccount() {
  return state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0] || null;
}

function accountTarget(account) {
  if (account?.targetUrl || account?.memo) return account.targetUrl || account.memo;
  if (account?.channelDiscovery?.channelUrl) return account.channelDiscovery.channelUrl;
  const username = String(account?.usernameHint || '').replace(/@naver\.com$/i, '');
  if (account?.platform === 'blog') return 'https://blog.naver.com/MyBlog.naver';
  if (account?.platform === 'cafe') return 'https://cafe.naver.com';
  if (account?.platform === 'premium') return 'https://contents.premium.naver.com';
  if (account?.platform === 'brunch' && username) return `https://brunch.co.kr/@${username}`;
  return 'https://blog.naver.com';
}

function editorUrl(account) {
  if (account?.platform === 'cafe') return accountTarget(account);
  if (account?.platform === 'premium') return 'https://contents.premium.naver.com';
  if (account?.platform === 'brunch') return 'https://brunch.co.kr/write';
  if (account?.platform === 'blog') return 'https://blog.naver.com/MyBlog.naver';
  return accountTarget(account);
}

async function saveResolvedChannel(account, channelUrl, tab) {
  if (!account || !channelUrl || account.targetUrl === channelUrl) return;
  await api('/account-slots', {
    method: 'POST',
    body: JSON.stringify({
      slotId: account.id,
      platform: account.platform,
      label: account.label,
      usernameHint: account.usernameHint,
      targetUrl: channelUrl,
      loginStatus: account.loginStatus || '확장 로그인 확인 완료',
      channelDiscovery: {
        ...(account.channelDiscovery || {}),
        ok: true,
        source: 'extension_myblog_resolve',
        channelUrl,
        pageTitle: tab?.title || '',
        detectedAt: new Date().toISOString(),
      },
    }),
  });
  await loadAccounts().catch(() => {});
}

async function updateLoginStatus(account, status) {
  await api('/account-slots', {
    method: 'POST',
    body: JSON.stringify({
      slotId: account.id,
      platform: account.platform,
      label: account.label,
      usernameHint: account.usernameHint,
      targetUrl: account.targetUrl || account.memo || '',
      loginStatus: status,
    }),
  });
  await loadAccounts();
}

function renderAccounts() {
  const select = $('accountSelect');
  if (!state.accounts.length) {
    select.innerHTML = '<option value="">계정 슬롯 없음</option>';
    setText('accountHint', '사이트 설정에서 발행 계정 슬롯을 먼저 만들어주세요.');
    return;
  }
  select.innerHTML = state.accounts.map((account) => {
    const label = account.label || account.id;
    const meta = `${account.platform || 'platform'} · ${account.loginStatus || '인증 필요'} · ${account.hasCredential ? 'ID/PW 저장' : 'ID/PW 없음'}`;
    return `<option value="${account.id}">${label} (${meta})</option>`;
  }).join('');
  select.value = state.selectedAccountId || state.accounts[0].id;
  const account = selectedAccount();
  setText('accountHint', account ? `${account.label || account.id} · ${accountTarget(account)}` : '계정 슬롯을 선택하세요.');
  renderCategoryBox(account);
  renderJobList();
}

function renderJob() {
  const box = $('jobBox');
  if (!state.activeJob) {
    box.textContent = '대기 중인 작업을 가져오세요.';
    box.classList.add('muted');
    return;
  }
  const job = normalizeEditorJob(state.activeJob);
  box.classList.remove('muted');
  const body = job.body || job.plain_text || job.plainText || '';
  const preview = body.length > 700 ? `${body.slice(0, 700)}...` : body;
  box.innerHTML = `<strong>${escapeHtml(job.title || job.keyword || '제목 없음')}</strong><span class="muted">${escapeHtml(job.platform || '')} · ${escapeHtml(job.status || job.publish_status || '')}</span><pre>${escapeHtml(preview)}</pre>`;
  $('publishedUrl').value = job.published_url || '';
}

function renderImages() {
  const box = $('imageBox');
  if (!state.images.length) {
    box.textContent = '아직 불러온 이미지가 없습니다.';
    return;
  }
  box.innerHTML = state.images.map((image, index) => {
    const label = image.label || image.image_role || `이미지 ${index + 1}`;
    return `<div>${index + 1}. ${escapeHtml(label)} · ${escapeHtml(image.downloadUrl || image.url || '서버 저장')}</div>`;
  }).join('');
}

function normalizeEditorImages(images = []) {
  return images.map((image) => {
    const url = image.downloadUrl || image.download_url || image.publicUrl || image.public_url || image.url || image.dataUrl || image.data_url || '';
    return {
      ...image,
      downloadUrl: absoluteApiAssetUrl(url),
      url: absoluteApiAssetUrl(url),
    };
  });
}

function imagesFromRewriteJob(job = {}) {
  return normalizeEditorImages(parseJsonArray(job.images_json || job.imagesJson).map((image, index) => ({
    ...image,
    label: image.label || image.title || image.section || image.role || image.image_role || `이미지 ${index + 1}`,
  })));
}

async function fetchJobImages(jobId) {
  const job = state.jobs.find((item) => Number(item.id) === Number(jobId)) || state.activeJob || {};
  return imagesFromRewriteJob(job);
}

function publishWaitingJobs() {
  return state.jobs.filter((job) => {
    return (job.status || '') === '글생성 완료';
  });
}

function renderJobList() {
  const box = $('jobList');
  const jobs = publishWaitingJobs();
  state.selectedJobIds = state.selectedJobIds.map((id) => Number(id)).filter((id) => jobs.some((job) => Number(job.id) === id));
  chrome.storage.local.set({ selectedJobIds: state.selectedJobIds });
  setText('selectedJobCount', `선택 ${state.selectedJobIds.length}개 / 글생성 완료 ${jobs.length}개`);
  if (!jobs.length) {
    box.textContent = '사이트의 발행 생성 작업 목록에 글생성 완료 작업이 없습니다. 발행 생성에서 글을 먼저 만들어주세요.';
    box.classList.add('muted');
    return;
  }
  box.classList.remove('muted');
  box.innerHTML = jobs.map((job) => {
    const checked = state.selectedJobIds.includes(job.id) ? 'checked' : '';
    const account = selectedAccount();
    const platformMatch = !account?.platform || job.platform === account.platform || job.publish_account_platform === account.platform;
    const meta = `#${job.id} · ${job.platform || '-'} · ${job.status || '-'} · ${Number(job.char_count || 0).toLocaleString()}자 · 이미지 ${job.image_count || imagesFromRewriteJob(job).length || 0}${platformMatch ? '' : ' · 선택 계정과 플랫폼 다름'}`;
    return `<label class="job-choice">
      <input type="checkbox" data-job-id="${job.id}" ${checked} />
      <span>
        <strong>${escapeHtml(job.title || job.target_keyword || job.keyword || '제목 없음')}</strong>
        <span>${escapeHtml(meta)}</span>
      </span>
    </label>`;
  }).join('');
  box.querySelectorAll('input[data-job-id]').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = Number(input.dataset.jobId);
      state.selectedJobIds = input.checked
        ? [...new Set([...state.selectedJobIds, id])]
        : state.selectedJobIds.filter((item) => item !== id);
      await chromePromise((done) => chrome.storage.local.set({ selectedJobIds: state.selectedJobIds }, done));
      renderJobList();
    });
  });
}

async function selectAllVisibleJobs() {
  state.selectedJobIds = publishWaitingJobs().map((job) => job.id);
  await chromePromise((done) => chrome.storage.local.set({ selectedJobIds: state.selectedJobIds }, done));
  renderJobList();
}

async function clearSelectedJobs() {
  state.selectedJobIds = [];
  await chromePromise((done) => chrome.storage.local.set({ selectedJobIds: [] }, done));
  renderJobList();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function loadPublishJobs() {
  setStep('claim', 'active', '사이트의 발행 생성 작업 목록을 불러오는 중입니다.');
  const jobs = await api('/rewrite-jobs?status=글생성 완료&limit=120');
  state.jobs = Array.isArray(jobs) ? jobs : [];
  renderJobList();
  setStep('claim', 'done', `글생성 완료 작업 ${publishWaitingJobs().length}개 확인`);
}

async function claimSelectedJob(jobId) {
  const account = selectedAccount();
  if (!account) throw new Error('계정 슬롯이 없습니다.');
  const job = publishWaitingJobs().find((item) => Number(item.id) === Number(jobId));
  if (!job) throw new Error(`#${jobId} 작업을 발행 생성 작업 목록에서 찾지 못했습니다.`);
  return normalizeEditorJob(job);
}

async function setActiveJob(job, images = []) {
  state.activeJob = normalizeEditorJob(job);
  state.images = images;
  await chromePromise((done) => chrome.storage.local.set({
    activeJob: state.activeJob,
    images: state.images,
    selectedJobIds: state.selectedJobIds,
  }, done));
  renderJob();
  renderImages();
}

function actionDelaySeconds(job) {
  const inputDelay = clampNumber($('batchDelaySeconds')?.value, 5, 600, state.batchDelaySeconds || 60);
  const jobDelay = clampNumber(job?.action_delay_max_seconds || job?.action_delay_min_seconds, 5, 600, inputDelay);
  return Math.max(inputDelay, jobDelay);
}

async function startSelectedJobs() {
  if (state.batchRunning) throw new Error('이미 선택 작업을 진행 중입니다.');
  selectTab('job');
  if (!state.jobs.length) await loadPublishJobs();
  if (!state.selectedJobIds.length) throw new Error('작업 탭에서 진행할 작업을 체크해 주세요.');

  const account = selectedAccount();
  if (!account) throw new Error('계정 슬롯이 없습니다.');
  await saveBatchDelaySeconds();
  state.batchRunning = true;
  $('startSelectedJobs').disabled = true;
  $('runSelectedJobs').disabled = true;

  const plannedIds = [...state.selectedJobIds];
  let completed = 0;
  try {
    for (let index = 0; index < plannedIds.length; index += 1) {
      const jobId = plannedIds[index];
      setStep('claim', 'active', `선택 작업 ${plannedIds.length}개 중 ${index + 1}번째 작업을 준비합니다.`);
      const job = await claimSelectedJob(jobId);
      if (!job) throw new Error(`#${jobId} 작업을 준비하지 못했습니다.`);

      setStep('images', 'active', `#${job.id} 이미지 초안을 자동으로 불러오는 중입니다.`);
      const images = await fetchJobImages(job.id);
      state.selectedJobIds = state.selectedJobIds.filter((id) => id !== job.id);
      await setActiveJob(job, images);
      setStep('claim', 'done', `#${job.id} 작업 준비 완료`);
      setStep('images', 'done', `${images.length}장 자동 확인`);

      const tab = await openEditorForJob();
      await delay(2500);
      const insertResult = await insertIntoTab(tab?.id, { retryMs: 25000 });
      if (!insertResult?.ok) throw new Error(insertResult?.error || `#${job.id} 작성창 삽입에 실패했습니다.`);
      setStep('insert', 'done', `#${job.id} 제목/본문/이미지/CTA 삽입 완료`);
      completed += 1;

      if (index < plannedIds.length - 1) {
        const waitSeconds = actionDelaySeconds(job);
        setStep('publish', 'active', `다음 작업까지 ${waitSeconds}초 대기합니다. 실제 발행 후 URL 저장은 발행 완료 저장으로 처리합니다.`);
        await delay(waitSeconds * 1000);
      }
    }
    await chromePromise((done) => chrome.storage.local.set({ selectedJobIds: state.selectedJobIds }, done));
    await loadPublishJobs().catch(() => {});
    setStep('publish', 'done', `${completed}개 작업을 작성창에 순서대로 넣었습니다.`);
  } finally {
    state.batchRunning = false;
    $('startSelectedJobs').disabled = false;
    $('runSelectedJobs').disabled = false;
    renderJobList();
  }
}

async function loadJobImages() {
  if (!state.activeJob?.id) throw new Error('이미지를 불러올 작업이 없습니다.');
  setStep('images', 'active', '서버 이미지 목록을 불러오는 중입니다.');
  state.images = await fetchJobImages(state.activeJob.id);
  await chromePromise((done) => chrome.storage.local.set({ images: state.images }, done));
  renderImages();
  setStep('images', 'done', `${state.images.length}장 확인`);
}

function jobText(job) {
  if (!job) return '';
  const normalized = normalizeEditorJob(job);
  return [normalized.title || normalized.keyword || '', '', normalized.body || normalized.plain_text || normalized.plainText || ''].join('\n');
}

async function copyJob() {
  const text = jobText(state.activeJob);
  if (!text.trim()) throw new Error('복사할 작업이 없습니다.');
  await navigator.clipboard.writeText(text);
  setText('loginText', '원고를 클립보드에 복사했습니다.');
}

async function openEditorForJob() {
  const account = selectedAccount();
  if (!account) throw new Error('계정 슬롯이 없습니다.');
  if (!state.activeJob) throw new Error('작업 탭에서 진행할 작업을 먼저 선택해 주세요.');
  const bundle = { job: state.activeJob, images: state.images, account };
  await chromePromise((done) => chrome.storage.local.set({ activeJobBundle: bundle }, done));
  let tab = await chrome.tabs.create({ url: editorUrl(account), active: true });
  tab = await waitForTabComplete(tab.id, 15000);
  if (account.platform === 'blog' && tab?.id) {
    const resolvedChannelUrl = blogUrlFromLocation(tab.url || '');
    if (resolvedChannelUrl) await saveResolvedChannel(account, resolvedChannelUrl, tab).catch(() => {});
    const clicked = await clickWriteButtonInTab(tab.id);
    tab = await waitForTabComplete(tab.id, 15000);
    setStep('editor', clicked?.ok ? 'done' : 'active', clicked?.ok ? '블로그 탭에서 글쓰기 버튼을 눌렀습니다. 로딩 후 현재 탭 삽입을 누르세요.' : '블로그 탭을 열었습니다. 글쓰기 버튼을 직접 누른 뒤 현재 탭 삽입을 누르세요.');
    return tab;
  }
  setStep('editor', 'done', '작성 화면을 열었습니다. 로딩 후 현재 탭 삽입을 누르세요.');
  return tab;
}

async function sendFillMessageToFrame(tabId, frameId) {
  return chromePromise((done) => chrome.tabs.sendMessage(tabId, {
    type: 'NAVIWRITE_FILL_JOB',
    job: normalizeEditorJob(state.activeJob),
    images: state.images,
  }, { frameId }, done)).catch((err) => ({ ok: false, error: err.message }));
}

async function insertIntoTab(tabId, { retryMs = 12000 } = {}) {
  if (!state.activeJob) throw new Error('삽입할 작업이 없습니다.');
  if (!tabId) throw new Error('작성 탭을 찾을 수 없습니다.');
  setStep('insert', 'active', '작성창의 제목/본문 영역을 찾는 중입니다.');
  const started = Date.now();
  let lastResponse = null;
  while (Date.now() - started < retryMs) {
    const frames = await chromePromise((done) => chrome.webNavigation.getAllFrames({ tabId }, done))
      .catch(() => [{ frameId: 0 }]);
    const orderedFrames = (frames || [{ frameId: 0 }]).sort((a, b) => (a.frameId === 0 ? 1 : b.frameId === 0 ? -1 : 0));
    for (const frame of orderedFrames) {
      const response = await sendFillMessageToFrame(tabId, frame.frameId);
      lastResponse = response;
      if (response?.ok) return response;
    }
    await delay(900);
  }
  return lastResponse || { ok: false, error: '작성 영역을 찾지 못했습니다.' };
}

async function insertIntoActiveTab() {
  if (!state.activeJob) throw new Error('삽입할 작업이 없습니다.');
  const tabs = await chromePromise((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
  const tab = tabs?.[0];
  if (!tab?.id) throw new Error('현재 탭을 찾을 수 없습니다.');
  const response = await insertIntoTab(tab.id);
  if (!response?.ok) {
    setStep('insert', 'error', response?.error || '삽입 가능한 작성 영역을 찾지 못했습니다.');
    return;
  }
  setStep('insert', 'done', response.note || '작성 영역에 원고를 삽입했습니다.');
}

async function markPublished() {
  if (!state.activeJob?.id) throw new Error('발행 완료 저장할 작업이 없습니다.');
  const rewriteJobId = state.activeJob.rewrite_job_id || state.activeJob.rewriteJobId || state.activeJob.id;
  let publishedUrl = $('publishedUrl').value.trim();
  if (!publishedUrl) {
    const tabs = await chromePromise((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
    publishedUrl = tabs?.[0]?.url || '';
  }
  const data = await api(`/rewrite-jobs/${rewriteJobId}/mark-published`, {
    method: 'POST',
    body: JSON.stringify({ publishedUrl }),
  });
  state.activeJob = normalizeEditorJob(data.job || state.activeJob);
  await chromePromise((done) => chrome.storage.local.set({ activeJob: state.activeJob }, done));
  renderJob();
  setStep('publish', 'done', '발행 URL과 완료 상태를 서버에 저장했습니다.');
}

async function clearJob() {
  state.activeJob = null;
  state.images = [];
  await chromePromise((done) => chrome.storage.local.remove(['activeJob', 'images', 'activeJobBundle'], done));
  renderJob();
  renderImages();
  resetSteps();
}

async function openJobTabAndStart() {
  selectTab('job');
  await loadPublishJobs();
  if (!state.selectedJobIds.length) {
    setText('loginText', '작업 탭에서 글생성 완료 작업을 체크한 뒤 작업 시작을 누르세요.');
    setStep('claim', 'active', '발행 생성 작업 목록에서 진행할 글을 체크해 주세요.');
    return;
  }
  await startSelectedJobs();
}

async function init() {
  await loadSettings();
  renderSteps();
  renderJob();
  renderImages();
  await checkNaverLogin(false);
  await loadAccounts().catch((err) => setText('loginText', err.message));
  await loadPublishJobs().catch((err) => setText('loginText', err.message));

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  });
  $('accountSelect').addEventListener('change', async () => {
    state.selectedAccountId = $('accountSelect').value;
    state.selectedJobIds = [];
    await chromePromise((done) => chrome.storage.local.set({ selectedAccountId: state.selectedAccountId, selectedJobIds: [] }, done));
    renderAccounts();
    await loadPublishJobs().catch((err) => setText('loginText', err.message));
  });
  $('saveApi').addEventListener('click', () => saveSettings().catch((err) => setText('loginText', err.message)));
  $('openLogin').addEventListener('click', () => chrome.tabs.create({ url: 'https://nid.naver.com/nidlogin.login' }));
  $('openSite').addEventListener('click', () => chrome.tabs.create({ url: state.apiBase }));
  $('reloadAccounts').addEventListener('click', () => loadAccounts().catch((err) => setText('loginText', err.message)));
  $('checkLogin').addEventListener('click', () => checkNaverLogin(true).catch((err) => setText('loginText', err.message)));
  $('detectChannel').addEventListener('click', () => discoverChannel().catch((err) => setText('loginText', err.message)));
  $('runSelectedJobs').addEventListener('click', () => openJobTabAndStart().catch((err) => setText('loginText', err.message)));
  $('reloadJobs').addEventListener('click', () => loadPublishJobs().catch((err) => setText('loginText', err.message)));
  $('selectAllJobs').addEventListener('click', () => selectAllVisibleJobs().catch((err) => setText('loginText', err.message)));
  $('clearSelectedJobs').addEventListener('click', () => clearSelectedJobs().catch((err) => setText('loginText', err.message)));
  $('batchDelaySeconds').addEventListener('change', () => saveBatchDelaySeconds().catch((err) => setText('loginText', err.message)));
  $('startSelectedJobs').addEventListener('click', () => startSelectedJobs().catch((err) => setText('loginText', err.message)));
  $('loadImages').addEventListener('click', () => loadJobImages().catch((err) => setText('loginText', err.message)));
  $('copyJob').addEventListener('click', () => copyJob().catch((err) => setText('loginText', err.message)));
  $('openEditor').addEventListener('click', () => openEditorForJob().catch((err) => setText('loginText', err.message)));
  $('insertJob').addEventListener('click', () => insertIntoActiveTab().catch((err) => setText('loginText', err.message)));
  $('markPublished').addEventListener('click', () => markPublished().catch((err) => setText('loginText', err.message)));
  $('clearJob').addEventListener('click', () => clearJob().catch((err) => setText('loginText', err.message)));
}

init();
