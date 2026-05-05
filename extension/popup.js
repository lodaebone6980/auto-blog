const DEFAULT_API = 'https://web-production-184ff.up.railway.app';

const STEPS = [
  ['login', '네이버 로그인 확인', '현재 Chrome 세션의 네이버 로그인을 확인합니다.'],
  ['channel', '채널/카테고리 확인', '블로그 URL과 카테고리 후보를 감지해 서버에 저장합니다.'],
  ['claim', '발행 작업 점유', '서버 발행큐에서 겹치지 않게 다음 작업을 가져옵니다.'],
  ['images', '이미지 불러오기', '서버에 저장된 500x500 이미지 초안을 확인합니다.'],
  ['editor', '작성창 이동', '선택 계정의 플랫폼 작성 화면을 엽니다.'],
  ['insert', '원고 삽입', '현재 작성 화면에 제목과 본문을 삽입합니다.'],
  ['publish', '발행 완료 저장', '발행 URL과 상태를 서버에 저장합니다.'],
];

const state = {
  apiBase: DEFAULT_API,
  accounts: [],
  selectedAccountId: '',
  activeJob: null,
  images: [],
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
  const saved = await chromePromise((done) => chrome.storage.local.get(['apiBase', 'selectedAccountId', 'activeJob', 'images'], done));
  state.apiBase = saved.apiBase || DEFAULT_API;
  state.selectedAccountId = saved.selectedAccountId || '';
  state.activeJob = saved.activeJob || null;
  state.images = saved.images || [];
  $('apiBase').value = state.apiBase;
}

async function saveSettings() {
  state.apiBase = $('apiBase').value.trim() || DEFAULT_API;
  await chromePromise((done) => chrome.storage.local.set({ apiBase: state.apiBase }, done));
  setText('loginText', '서버 URL을 저장했습니다.');
  await loadAccounts();
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
    const parts = parsed.pathname.split('/').filter(Boolean);
    const blogId = parts.find((part) => !['PostView.naver', 'PostList.naver', 'PostWriteForm.naver', 'MyBlog.naver'].includes(part));
    return blogId ? `https://blog.naver.com/${blogId}` : '';
  } catch {
    return '';
  }
}

function candidateChannelUrl(account) {
  if (account?.targetUrl) return account.targetUrl;
  const username = String(account?.usernameHint || '').replace(/@naver\.com$/i, '').trim();
  if (account?.platform === 'blog' && username) return `https://blog.naver.com/${username}`;
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
  const username = String(account?.usernameHint || '').replace(/@naver\.com$/i, '');
  if (account?.platform === 'blog' && username) return `https://blog.naver.com/${username}`;
  if (account?.platform === 'cafe') return 'https://cafe.naver.com';
  if (account?.platform === 'premium') return 'https://contents.premium.naver.com';
  if (account?.platform === 'brunch' && username) return `https://brunch.co.kr/@${username}`;
  return 'https://blog.naver.com';
}

function editorUrl(account) {
  if (account?.platform === 'cafe') return accountTarget(account);
  if (account?.platform === 'premium') return 'https://contents.premium.naver.com';
  if (account?.platform === 'brunch') return 'https://brunch.co.kr/write';
  return 'https://blog.naver.com/PostWriteForm.naver';
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
}

function renderJob() {
  const box = $('jobBox');
  const job = state.activeJob;
  if (!job) {
    box.textContent = '대기 중인 작업을 가져오세요.';
    box.classList.add('muted');
    return;
  }
  box.classList.remove('muted');
  const body = job.body || job.plain_text || job.plainText || '';
  const preview = body.length > 700 ? `${body.slice(0, 700)}...` : body;
  box.innerHTML = `<strong>${escapeHtml(job.title || job.keyword || '제목 없음')}</strong><span class="muted">${escapeHtml(job.platform || '')} · ${escapeHtml(job.publish_status || '')}</span><pre>${escapeHtml(preview)}</pre>`;
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function claimNextJob() {
  const account = selectedAccount();
  if (!account) throw new Error('계정 슬롯이 없습니다.');
  setStep('claim', 'active', '서버 발행큐에서 다음 작업을 점유합니다.');
  const data = await api('/publish-queue/claim-next', {
    method: 'POST',
    body: JSON.stringify({
      platform: account.platform,
      publishAccountId: account.id,
      publishAccountLabel: account.label,
    }),
  });
  state.activeJob = data.job || null;
  state.images = [];
  await chromePromise((done) => chrome.storage.local.set({ activeJob: state.activeJob, images: state.images }, done));
  renderJob();
  renderImages();
  setStep('claim', state.activeJob ? 'done' : 'error', state.activeJob ? '작업 점유 완료' : '지금 발행 가능한 작업이 없습니다.');
  if (state.activeJob) selectTab('job');
}

async function loadJobImages() {
  if (!state.activeJob?.id) throw new Error('이미지를 불러올 작업이 없습니다.');
  setStep('images', 'active', '서버 이미지 목록을 불러오는 중입니다.');
  const data = await api(`/publish-queue/${state.activeJob.id}/images`);
  state.images = data.images || [];
  await chromePromise((done) => chrome.storage.local.set({ images: state.images }, done));
  renderImages();
  setStep('images', 'done', `${state.images.length}장 확인`);
}

function jobText(job) {
  if (!job) return '';
  return [job.title || job.keyword || '', '', job.body || job.plain_text || job.plainText || ''].join('\n');
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
  if (!account.targetUrl && account.platform === 'blog') {
    await discoverChannel();
  }
  const bundle = { job: state.activeJob, images: state.images, account };
  await chromePromise((done) => chrome.storage.local.set({ activeJobBundle: bundle }, done));
  await chrome.tabs.create({ url: editorUrl(account) });
  setStep('editor', 'done', '작성창을 열었습니다. 로딩 후 현재 탭 삽입을 누르세요.');
}

async function insertIntoActiveTab() {
  if (!state.activeJob) throw new Error('삽입할 작업이 없습니다.');
  const tabs = await chromePromise((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
  const tab = tabs?.[0];
  if (!tab?.id) throw new Error('현재 탭을 찾을 수 없습니다.');
  setStep('insert', 'active', '현재 탭의 작성 영역을 찾는 중입니다.');
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'NAVIWRITE_FILL_JOB',
    job: state.activeJob,
    images: state.images,
  }).catch((err) => ({ ok: false, error: err.message }));
  if (!response?.ok) {
    setStep('insert', 'error', response?.error || '삽입 가능한 작성 영역을 찾지 못했습니다.');
    return;
  }
  setStep('insert', 'done', response.note || '작성 영역에 원고를 삽입했습니다.');
}

async function markPublished() {
  if (!state.activeJob?.id) throw new Error('발행 완료 저장할 작업이 없습니다.');
  let publishedUrl = $('publishedUrl').value.trim();
  if (!publishedUrl) {
    const tabs = await chromePromise((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
    publishedUrl = tabs?.[0]?.url || '';
  }
  const data = await api(`/publish-queue/${state.activeJob.id}/mark-published`, {
    method: 'POST',
    body: JSON.stringify({ publishedUrl }),
  });
  state.activeJob = data.job;
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

async function init() {
  await loadSettings();
  renderSteps();
  renderJob();
  renderImages();
  await checkNaverLogin(false);
  await loadAccounts().catch((err) => setText('loginText', err.message));

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  });
  $('accountSelect').addEventListener('change', async () => {
    state.selectedAccountId = $('accountSelect').value;
    await chromePromise((done) => chrome.storage.local.set({ selectedAccountId: state.selectedAccountId }, done));
    renderAccounts();
  });
  $('saveApi').addEventListener('click', () => saveSettings().catch((err) => setText('loginText', err.message)));
  $('openLogin').addEventListener('click', () => chrome.tabs.create({ url: 'https://nid.naver.com/nidlogin.login' }));
  $('openSite').addEventListener('click', () => chrome.tabs.create({ url: state.apiBase }));
  $('reloadAccounts').addEventListener('click', () => loadAccounts().catch((err) => setText('loginText', err.message)));
  $('checkLogin').addEventListener('click', () => checkNaverLogin(true).catch((err) => setText('loginText', err.message)));
  $('detectChannel').addEventListener('click', () => discoverChannel().catch((err) => setText('loginText', err.message)));
  $('claimNext').addEventListener('click', () => claimNextJob().catch((err) => setText('loginText', err.message)));
  $('loadImages').addEventListener('click', () => loadJobImages().catch((err) => setText('loginText', err.message)));
  $('copyJob').addEventListener('click', () => copyJob().catch((err) => setText('loginText', err.message)));
  $('openEditor').addEventListener('click', () => openEditorForJob().catch((err) => setText('loginText', err.message)));
  $('insertJob').addEventListener('click', () => insertIntoActiveTab().catch((err) => setText('loginText', err.message)));
  $('markPublished').addEventListener('click', () => markPublished().catch((err) => setText('loginText', err.message)));
  $('clearJob').addEventListener('click', () => clearJob().catch((err) => setText('loginText', err.message)));
}

init();
