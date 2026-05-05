const DEFAULT_API = 'https://web-production-184ff.up.railway.app';
const state = {
  apiBase: DEFAULT_API,
  accounts: [],
  selectedAccountId: '',
  activeJob: null,
  loggedIn: false,
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

async function loadSettings() {
  const saved = await chromePromise((done) => chrome.storage.local.get(['apiBase', 'selectedAccountId', 'activeJob'], done));
  state.apiBase = saved.apiBase || DEFAULT_API;
  state.selectedAccountId = saved.selectedAccountId || '';
  state.activeJob = saved.activeJob || null;
  $('apiBase').value = state.apiBase;
}

async function saveSettings() {
  state.apiBase = $('apiBase').value.trim() || DEFAULT_API;
  await chromePromise((done) => chrome.storage.local.set({ apiBase: state.apiBase }, done));
  await loadAccounts();
}

async function checkNaverLogin() {
  const cookies = await chromePromise((done) => chrome.cookies.getAll({ domain: '.naver.com' }, done)).catch(() => []);
  const loggedIn = cookies.some((cookie) => ['NID_AUT', 'NID_SES'].includes(cookie.name) && cookie.value);
  state.loggedIn = loggedIn;
  const badge = $('loginBadge');
  badge.textContent = loggedIn ? '로그인됨' : '로그인 필요';
  badge.className = `badge ${loggedIn ? 'ok' : 'fail'}`;
  setText('loginText', loggedIn ? '현재 Chrome 네이버 세션이 확인되었습니다.' : '네이버 로그인이 필요합니다. 로그인 열기를 눌러 진행하세요.');
  return loggedIn;
}

async function loadAccounts() {
  const data = await api('/account-slots');
  state.accounts = data.accounts || [];
  if (!state.selectedAccountId && state.accounts[0]) state.selectedAccountId = state.accounts[0].id;
  await chromePromise((done) => chrome.storage.local.set({ selectedAccountId: state.selectedAccountId }, done));
  renderAccounts();
}

function accountTarget(account) {
  if (account.targetUrl || account.memo) return account.targetUrl || account.memo;
  const username = String(account.usernameHint || '').replace(/@naver\.com$/i, '');
  if (account.platform === 'blog' && username) return `https://blog.naver.com/${username}`;
  if (account.platform === 'cafe') return 'https://cafe.naver.com';
  if (account.platform === 'premium') return 'https://contents.premium.naver.com';
  if (account.platform === 'brunch' && username) return `https://brunch.co.kr/@${username}`;
  return 'https://blog.naver.com';
}

function editorUrl(account) {
  if (account.platform === 'cafe') return accountTarget(account);
  if (account.platform === 'premium') return 'https://contents.premium.naver.com';
  if (account.platform === 'brunch') return 'https://brunch.co.kr/write';
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
  const root = $('accounts');
  if (!state.accounts.length) {
    root.innerHTML = '<p class="muted">서버에 등록된 계정 슬롯이 없습니다.</p>';
    return;
  }
  root.innerHTML = state.accounts.map((account) => `
    <div class="account">
      <strong>${account.label || account.id}</strong>
      <p>${account.platform} · ${account.loginStatus || '인증 필요'} · ${account.hasCredential ? 'ID/PW 저장됨' : 'ID/PW 없음'}</p>
      <div class="row">
        <button data-pick="${account.id}" class="secondary">선택</button>
        <button data-login="${account.id}">로그인 확인</button>
        <button data-open="${account.id}" class="secondary">작성창</button>
      </div>
    </div>
  `).join('');
  root.querySelectorAll('[data-pick]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.selectedAccountId = button.dataset.pick;
      await chromePromise((done) => chrome.storage.local.set({ selectedAccountId: state.selectedAccountId }, done));
      setText('loginText', `${button.dataset.pick} 계정을 선택했습니다.`);
    });
  });
  root.querySelectorAll('[data-login]').forEach((button) => {
    button.addEventListener('click', async () => {
      const account = state.accounts.find((item) => item.id === button.dataset.login);
      const loggedIn = await checkNaverLogin();
      await updateLoginStatus(account, loggedIn ? '확장 로그인 확인 완료' : '확장 로그인 필요');
    });
  });
  root.querySelectorAll('[data-open]').forEach((button) => {
    button.addEventListener('click', async () => {
      const account = state.accounts.find((item) => item.id === button.dataset.open);
      await chrome.tabs.create({ url: editorUrl(account) });
    });
  });
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
  box.innerHTML = `<strong>${job.title || job.keyword || '제목 없음'}</strong><br><span class="muted">${job.platform || ''} · ${job.publish_status || ''}</span>`;
}

async function claimNextJob() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  if (!account) throw new Error('계정 슬롯이 없습니다.');
  const data = await api('/publish-queue/claim-next', {
    method: 'POST',
    body: JSON.stringify({
      platform: account.platform,
      publishAccountId: account.id,
      publishAccountLabel: account.label,
    }),
  });
  state.activeJob = data.job || null;
  await chromePromise((done) => chrome.storage.local.set({ activeJob: state.activeJob }, done));
  renderJob();
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
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  if (!account) throw new Error('계정 슬롯이 없습니다.');
  await chrome.tabs.create({ url: editorUrl(account) });
}

async function init() {
  await loadSettings();
  await checkNaverLogin();
  await loadAccounts().catch((err) => setText('loginText', err.message));
  renderJob();
  $('saveApi').addEventListener('click', () => saveSettings().catch((err) => setText('loginText', err.message)));
  $('openLogin').addEventListener('click', () => chrome.tabs.create({ url: 'https://nid.naver.com/nidlogin.login' }));
  $('reloadAccounts').addEventListener('click', () => loadAccounts().catch((err) => setText('loginText', err.message)));
  $('claimNext').addEventListener('click', () => claimNextJob().catch((err) => setText('loginText', err.message)));
  $('copyJob').addEventListener('click', () => copyJob().catch((err) => setText('loginText', err.message)));
  $('openEditor').addEventListener('click', () => openEditorForJob().catch((err) => setText('loginText', err.message)));
}

init();
