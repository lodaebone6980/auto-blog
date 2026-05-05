import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.NAVIWRITE_RUNNER_PORT || 39271);
const DATA_DIR = process.env.NAVIWRITE_RUNNER_DATA || path.join(os.homedir(), 'NaviWriteRunner');
const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
const PUBLISH_JOB_DIR = path.join(DATA_DIR, 'publish-jobs');
const STORE_FILE = path.join(DATA_DIR, 'profiles.json');
const PUBLISH_QUEUE_FILE = path.join(DATA_DIR, 'publish-queue.json');
const ACTIVE_PUBLISH_FILE = path.join(DATA_DIR, 'active-publish-job.json');
const LOGIN_CHECK_INTERVAL_MS = Number(process.env.NAVIWRITE_LOGIN_CHECK_MS || 6 * 60 * 60 * 1000);
const INACTIVITY_RECHECK_MS = Number(process.env.NAVIWRITE_INACTIVITY_RECHECK_MS || 2 * 60 * 60 * 1000);

function nowIso() {
  return new Date().toISOString();
}

function safeId(value) {
  return String(value || `profile_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function credentialFileFor(id) {
  return path.join(DATA_DIR, `${safeId(id)}.credential.json`);
}

async function ensureStore() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  await fs.mkdir(PUBLISH_JOB_DIR, { recursive: true });
  if (!existsSync(STORE_FILE)) {
    await fs.writeFile(STORE_FILE, JSON.stringify({ profiles: [] }, null, 2), 'utf8');
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(STORE_FILE, 'utf8');
  return JSON.parse(raw || '{"profiles":[]}');
}

async function writeStore(store) {
  await ensureStore();
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

async function readPublishQueue() {
  await ensureStore();
  if (!existsSync(PUBLISH_QUEUE_FILE)) {
    return { batches: [], updatedAt: null };
  }
  const raw = await fs.readFile(PUBLISH_QUEUE_FILE, 'utf8');
  return JSON.parse(raw || '{"batches":[]}');
}

async function writePublishQueue(queue) {
  await ensureStore();
  await fs.writeFile(PUBLISH_QUEUE_FILE, JSON.stringify({ ...queue, updatedAt: nowIso() }, null, 2), 'utf8');
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function loginUrlFor(profile) {
  if (profile.loginUrl) return profile.loginUrl;
  if (profile.platform === 'brunch') return 'https://brunch.co.kr/signin';
  if (profile.platform === 'wordpress') return profile.targetUrl || '';
  return 'https://nid.naver.com/nidlogin.login';
}

function normalizeUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function normalizedUsername(value = '') {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^blog\.naver\.com\//i, '')
    .replace(/^m\.blog\.naver\.com\//i, '')
    .replace(/\/.*$/, '')
    .replace(/@naver\.com$/i, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '');
}

function channelCandidatesFor(profile = {}, credential = {}) {
  const candidates = [];
  const add = (url, reason) => {
    const normalized = normalizeUrl(url);
    if (normalized && !candidates.some((item) => item.url === normalized)) {
      candidates.push({ url: normalized, reason });
    }
  };
  const platform = profile.platform || 'blog';
  const username = normalizedUsername(credential.username || profile.usernameHint || '');
  add(profile.targetUrl, 'saved_target_url');
  if (platform === 'blog' && username) {
    add(`https://blog.naver.com/${username}`, 'naver_blog_id_candidate');
    add(`https://m.blog.naver.com/${username}`, 'naver_mobile_blog_candidate');
  } else if (platform === 'cafe') {
    add('https://cafe.naver.com', 'naver_cafe_home');
  } else if (platform === 'premium') {
    add('https://contents.premium.naver.com', 'naver_premium_home');
  } else if (platform === 'brunch' && username) {
    add(`https://brunch.co.kr/@${username}`, 'brunch_writer_candidate');
  } else if (platform === 'wordpress') {
    add(profile.targetUrl, 'wordpress_site_url');
  }
  return candidates;
}

async function probeChannelUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 NaviWriteRunner/0.2.2',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const text = await response.text().catch(() => '');
    const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, ' ')
      ?.trim()
      ?.slice(0, 120) || '';
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      finalUrl: response.url || url,
      title,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverChannel(profile = {}) {
  const credential = await credentialStatus(profile.id);
  const candidates = channelCandidatesFor(profile, credential);
  const checked = [];
  for (const candidate of candidates) {
    try {
      const result = await probeChannelUrl(candidate.url);
      checked.push({ ...candidate, ...result });
      if (result.ok) {
        return {
          ok: true,
          url: result.finalUrl || candidate.url,
          title: result.title,
          source: candidate.reason,
          candidates: checked,
        };
      }
    } catch (err) {
      checked.push({ ...candidate, ok: false, error: err.message || 'probe failed' });
    }
  }
  return {
    ok: false,
    url: candidates[0]?.url || '',
    title: '',
    source: candidates[0]?.reason || 'none',
    candidates: checked.length ? checked : candidates,
  };
}

function editorUrlFor(profile = {}, job = {}) {
  const target = normalizeUrl(profile.targetUrl || '');
  if (target) return target;
  const platform = job.platform || profile.platform;
  if (platform === 'wordpress') return '';
  if (platform === 'brunch') return 'https://brunch.co.kr/write';
  if (platform === 'premium') return 'https://contents.premium.naver.com';
  if (platform === 'cafe') return 'https://cafe.naver.com';
  return 'https://blog.naver.com/PostWriteForm.naver';
}

function sessionStatus(profile) {
  const now = Date.now();
  const lastLoginChecked = profile.lastLoginCheckedAt ? Date.parse(profile.lastLoginCheckedAt) : 0;
  const lastActivity = profile.lastActivityAt ? Date.parse(profile.lastActivityAt) : 0;
  const loginCheckAge = lastLoginChecked ? now - lastLoginChecked : Number.POSITIVE_INFINITY;
  const inactivityAge = lastActivity ? now - lastActivity : 0;
  const needsLoginCheck = !lastLoginChecked || loginCheckAge > (profile.loginCheckIntervalMs || LOGIN_CHECK_INTERVAL_MS);
  const needsActivityCheck = Boolean(lastActivity && inactivityAge > (profile.inactivityRecheckMs || INACTIVITY_RECHECK_MS));

  return {
    loginStatus: profile.loginStatus || '로그인 체크 필요',
    needsLoginCheck: needsLoginCheck || needsActivityCheck,
    needsActivityCheck,
    loginCheckAgeMs: Number.isFinite(loginCheckAge) ? loginCheckAge : null,
    inactivityAgeMs: inactivityAge || null,
    lastLoginCheckedAt: profile.lastLoginCheckedAt || null,
    lastActivityAt: profile.lastActivityAt || null,
  };
}

async function credentialStatus(id) {
  const file = credentialFileFor(id);
  if (!existsSync(file)) {
    return {
      hasCredential: false,
      username: '',
      mode: 'none',
      updatedAt: null,
      verifiedAt: null,
    };
  }

  const raw = await fs.readFile(file, 'utf8');
  const data = JSON.parse(raw || '{}');
  return {
    hasCredential: Boolean(data.encryptedPassword),
    username: data.username || '',
    mode: data.mode || 'windows-dpapi',
    updatedAt: data.updatedAt || null,
    verifiedAt: data.verifiedAt || null,
  };
}

async function loginPlanFor(profile) {
  const session = sessionStatus(profile);
  const credential = await credentialStatus(profile.id);
  let recommendedAction = 'ready';
  let reason = '최근 로그인 체크 기준으로 바로 사용할 수 있습니다.';

  if (session.needsLoginCheck && credential.hasCredential) {
    recommendedAction = 'verify_saved_credential_or_open_login';
    reason = '체크 주기가 지났습니다. 저장된 로컬 자격증명을 확인하거나 로그인 창을 열어 재확인하세요.';
  } else if (session.needsLoginCheck) {
    recommendedAction = 'open_login_and_confirm';
    reason = '저장된 자격증명이 없어 로그인 창에서 직접 확인해야 합니다.';
  } else if (!credential.hasCredential) {
    recommendedAction = 'session_only';
    reason = '세션은 최근 확인됐지만 저장된 ID/PW는 없습니다.';
  }

  return {
    profileId: profile.id,
    recommendedAction,
    reason,
    session,
    credential,
  };
}

async function upsertProfile(payload) {
  const store = await readStore();
  const id = safeId(payload.id || payload.label);
  const profilePath = path.join(PROFILE_DIR, id);
  await fs.mkdir(profilePath, { recursive: true });

  const previous = store.profiles.find((profile) => profile.id === id);
  const profile = {
    ...(previous || {}),
    id,
    label: payload.label || previous?.label || id,
    platform: payload.platform || previous?.platform || 'blog',
    targetUrl: payload.targetUrl || previous?.targetUrl || '',
    loginUrl: payload.loginUrl || previous?.loginUrl || '',
    usernameHint: payload.usernameHint || previous?.usernameHint || '',
    profilePath,
    credentialKey: `naviwrite/${id}`,
    credentialMode: previous?.credentialMode || 'none',
    loginStatus: previous?.loginStatus || '로그인 체크 필요',
    loginCheckIntervalMs: Number(payload.loginCheckIntervalHours || 6) * 60 * 60 * 1000,
    inactivityRecheckMs: Number(payload.inactivityRecheckHours || 2) * 60 * 60 * 1000,
    updatedAt: nowIso(),
    createdAt: previous?.createdAt || nowIso(),
  };

  store.profiles = previous
    ? store.profiles.map((item) => (item.id === id ? profile : item))
    : [...store.profiles, profile];
  await writeStore(store);
  return profile;
}

async function updateProfile(id, patch) {
  const store = await readStore();
  let found = null;
  store.profiles = store.profiles.map((profile) => {
    if (profile.id !== id) return profile;
    found = { ...profile, ...patch, updatedAt: nowIso() };
    return found;
  });
  if (!found) return null;
  await writeStore(store);
  return found;
}

async function readProfile(id) {
  const store = await readStore();
  return store.profiles.find((item) => item.id === id) || null;
}

function runPowerShell(command, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `PowerShell exited with ${code}`));
    });
  });
}

async function encryptSecretLocal(secret) {
  if (process.platform !== 'win32') {
    throw new Error('Local credential encryption currently requires Windows DPAPI.');
  }
  return runPowerShell('$s=ConvertTo-SecureString $env:NAVIWRITE_SECRET -AsPlainText -Force; ConvertFrom-SecureString $s', {
    NAVIWRITE_SECRET: secret,
  });
}

async function verifyEncryptedSecret(encryptedSecret) {
  if (process.platform !== 'win32') {
    throw new Error('Local credential verification currently requires Windows DPAPI.');
  }
  await runPowerShell(`
    $s=ConvertTo-SecureString $env:NAVIWRITE_SECRET
    $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [void][Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  `, {
    NAVIWRITE_SECRET: encryptedSecret,
  });
}

async function decryptSecretLocal(encryptedSecret) {
  if (process.platform !== 'win32') {
    throw new Error('Local credential decryption currently requires Windows DPAPI.');
  }
  return runPowerShell(`
    $s=ConvertTo-SecureString $env:NAVIWRITE_SECRET
    $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  `, {
    NAVIWRITE_SECRET: encryptedSecret,
  });
}

async function plainCredentialFor(id) {
  const file = credentialFileFor(id);
  if (!existsSync(file)) throw new Error('credential not found');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!raw.username || !raw.encryptedPassword) throw new Error('credential is incomplete');
  return {
    username: raw.username,
    password: await decryptSecretLocal(raw.encryptedPassword),
  };
}

async function setClipboardText(text) {
  if (process.platform !== 'win32') return false;
  await runPowerShell('Set-Clipboard -Value $env:NAVIWRITE_CLIPBOARD_TEXT', {
    NAVIWRITE_CLIPBOARD_TEXT: text || '',
  });
  return true;
}

function vpnPlan({ provider = 'nordvpn', target = '', execute = false }) {
  if (provider === 'nordvpn') {
    return {
      provider,
      execute,
      command: target ? ['nordvpn', '-c', '-g', target] : ['nordvpn', '-c'],
      note: 'execute=true 요청일 때만 실제 명령을 실행합니다.',
    };
  }
  if (provider === 'mullvad') {
    return {
      provider,
      execute,
      command: target ? ['mullvad', 'relay', 'set', 'location', target] : ['mullvad', 'connect'],
      followUpCommand: target ? ['mullvad', 'connect'] : [],
      note: 'Mullvad 위치 변경 뒤 연결은 수동 확인 권장입니다.',
    };
  }
  return {
    provider: 'manual',
    execute: false,
    command: [],
    note: '수동 VPN 전환 프로필입니다.',
  };
}

async function profilePayload(profile) {
  const credential = await credentialStatus(profile.id);
  return {
    ...profile,
    session: sessionStatus(profile),
    credential,
    hasCredential: credential.hasCredential,
  };
}

function delayPlanForJob(job = {}) {
  const actionDelaySeconds = Math.max(
    1,
    Number(job.action_delay_max_seconds || job.actionDelayMaxSeconds || job.action_delay_min_seconds || job.actionDelayMinSeconds || 60)
  );
  const betweenPostsMinutes = Math.max(1, Number(job.between_posts_delay_minutes || job.betweenPostsDelayMinutes || 120));
  return {
    actionDelaySeconds,
    actionDelayMs: actionDelaySeconds * 1000,
    betweenPostsMinutes,
    betweenPostsMs: betweenPostsMinutes * 60 * 1000,
  };
}

function normalizedApiBase(value = '') {
  return String(value || '').replace(/\/$/, '');
}

async function postApiJson(url, body = {}, tenantId = '') {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(tenantId ? { 'x-naviwrite-tenant': tenantId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(payload.error || payload.message || text || `API request failed (${response.status})`);
  }
  return payload;
}

async function requestRunnerPublishPlan({ apiBase = '', tenantId = '', job = {}, profile = {}, body = {} }) {
  const base = normalizedApiBase(apiBase);
  if (!base || !job.id) return { job, plan: null };
  const spacingMinMinutes = Number(body.spacingMinMinutes || job.between_posts_delay_minutes || job.betweenPostsDelayMinutes || 120);
  const spacingMaxMinutes = Number(body.spacingMaxMinutes || job.spacing_max_minutes || job.spacingMaxMinutes || 180);
  const payload = await postApiJson(`${base}/publish-queue/${job.id}/runner-plan`, {
    claim: true,
    runnerName: 'naviwrite-runner',
    lastPublishedAt: body.lastPublishedAt || body.latestPublishedAt || null,
    lastPublishedUrl: body.lastPublishedUrl || body.latestPublishedUrl || null,
    publishAccountId: profile.id || job.publish_account_id || '',
    publishAccountLabel: profile.label || job.publish_account_label || '',
    publishAccountPlatform: profile.platform || job.publish_account_platform || job.platform || '',
    spacingMinMinutes,
    spacingMaxMinutes,
  }, tenantId);
  return {
    job: payload.job || job,
    plan: payload.plan || null,
  };
}

function publishTextForJob(job = {}) {
  const title = job.title || job.keyword || '';
  const body = job.plain_text || job.plainText || job.body || '';
  return [title, '', body].filter((part) => part !== '').join('\n');
}

async function savePreparedPublishJob({ profile = {}, job = {}, editorUrl = '' }) {
  const id = job.id || `manual_${Date.now()}`;
  const baseName = `job-${safeId(id)}`;
  const text = publishTextForJob(job);
  const payload = {
    job,
    profile: {
      id: profile.id,
      label: profile.label,
      platform: profile.platform,
      targetUrl: profile.targetUrl,
    },
    editorUrl,
    delayPlan: delayPlanForJob(job),
    textFile: path.join(PUBLISH_JOB_DIR, `${baseName}.txt`),
    jsonFile: path.join(PUBLISH_JOB_DIR, `${baseName}.json`),
    preparedAt: nowIso(),
  };
  await fs.writeFile(payload.textFile, text, 'utf8');
  await fs.writeFile(payload.jsonFile, JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(ACTIVE_PUBLISH_FILE, JSON.stringify(payload, null, 2), 'utf8');
  const clipboardReady = await setClipboardText(text).catch(() => false);
  return { ...payload, clipboardReady };
}

function wordpressStatusFor(job = {}, requested = '') {
  if (requested) return requested;
  if (job.publish_mode === 'immediate') return 'publish';
  if (job.publish_mode === 'scheduled') {
    const date = job.scheduled_at ? new Date(job.scheduled_at) : null;
    return date && date.getTime() > Date.now() ? 'future' : 'publish';
  }
  return 'draft';
}

async function publishWordPressPost({ profile = {}, job = {}, status = '' }) {
  const siteUrl = normalizeUrl(profile.targetUrl || '');
  if (!siteUrl) throw new Error('WordPress site URL is required in account memo/targetUrl');
  const credential = await plainCredentialFor(profile.id);
  const wpStatus = wordpressStatusFor(job, status);
  const endpoint = `${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2/posts`;
  const payload = {
    title: job.title || job.keyword || 'NaviWrite draft',
    content: job.body || job.plain_text || job.plainText || '',
    status: wpStatus,
  };
  if (wpStatus === 'future' && job.scheduled_at) payload.date = job.scheduled_at;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(async () => ({ raw: await response.text().catch(() => '') }));
  if (!response.ok) {
    throw new Error(data.message || `WordPress publish failed (${response.status})`);
  }
  return {
    ok: true,
    wordpressStatus: wpStatus,
    wordpressId: data.id,
    link: data.link || data.guid?.rendered || '',
    raw: data,
  };
}

async function router(req, res) {
  const requestUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = requestUrl.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      return send(res, 200, {
        status: 'ok',
        service: 'naviwrite-runner',
        version: '0.2.2',
        dataDir: DATA_DIR,
        profileDir: PROFILE_DIR,
        browserFound: Boolean(findBrowserExecutable()),
        credentialStore: process.platform === 'win32' ? 'windows-dpapi-local' : 'unsupported',
        time: nowIso(),
      });
    }

    if (req.method === 'GET' && requestUrl.pathname === '/startup-check') {
      const store = await readStore();
      const profiles = await Promise.all(store.profiles.map(loginPlanFor));
      return send(res, 200, {
        ok: true,
        checkedAt: nowIso(),
        profiles,
      });
    }

    if (req.method === 'GET' && requestUrl.pathname === '/publish/queue') {
      return send(res, 200, await readPublishQueue());
    }

    if (req.method === 'POST' && requestUrl.pathname === '/publish/queue') {
      const body = await readBody(req);
      const queue = await readPublishQueue();
      const batch = {
        id: `batch_${Date.now()}`,
        apiBase: body.apiBase || '',
        jobIds: Array.isArray(body.jobIds) ? body.jobIds : [],
        spacingMinutes: Number(body.spacingMinutes || 120),
        actionDelayMinutes: Number(body.actionDelayMinutes || 1),
        status: '자동발행 대기',
        createdAt: body.createdAt || nowIso(),
      };
      const next = {
        batches: [batch, ...(Array.isArray(queue.batches) ? queue.batches : [])].slice(0, 50),
      };
      await writePublishQueue(next);
      return send(res, 200, { ok: true, batch, queue: next });
    }

    if (req.method === 'GET' && requestUrl.pathname === '/publish/active') {
      if (!existsSync(ACTIVE_PUBLISH_FILE)) return send(res, 200, { ok: true, active: null });
      const active = JSON.parse(await fs.readFile(ACTIVE_PUBLISH_FILE, 'utf8'));
      return send(res, 200, { ok: true, active });
    }

    if (req.method === 'POST' && requestUrl.pathname === '/publish/open-editor') {
      const body = await readBody(req);
      let job = body.job || {};
      const profileId = safeId(body.profileId || job.publish_account_id || '');
      const profile = profileId ? await readProfile(profileId) : null;
      if (!profile) return send(res, 404, { error: 'profile not found' });
      let publishPlan = null;
      if (body.autoPlan !== false && body.apiBase && job.id) {
        const planned = await requestRunnerPublishPlan({
          apiBase: body.apiBase,
          tenantId: body.tenantId || '',
          job,
          profile,
          body,
        });
        job = planned.job || job;
        publishPlan = planned.plan || null;
      }
      const editorUrl = body.editorUrl || editorUrlFor(profile, job);
      if (!editorUrl) return send(res, 400, { error: 'editor URL is required' });
      const prepared = await savePreparedPublishJob({ profile, job, editorUrl });
      const browser = findBrowserExecutable();
      if (!browser) return send(res, 500, { error: 'Chrome or Edge executable was not found.' });
      const child = spawn(browser, [
        `--user-data-dir=${profile.profilePath}`,
        '--no-first-run',
        '--disable-default-apps',
        editorUrl,
      ], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      await updateProfile(profile.id, { lastActivityAt: nowIso() });
      return send(res, 200, { ok: true, openedUrl: editorUrl, prepared, publishPlan });
    }

    if (req.method === 'POST' && requestUrl.pathname === '/publish/complete-job') {
      const body = await readBody(req);
      const apiBase = normalizedApiBase(body.apiBase);
      const jobId = body.jobId || body.job_id || body.job?.id;
      if (!apiBase) return send(res, 400, { error: 'apiBase is required' });
      if (!jobId) return send(res, 400, { error: 'jobId is required' });
      const payload = await postApiJson(`${apiBase}/publish-queue/${jobId}/mark-published`, {
        publishedUrl: body.publishedUrl || body.published_url || '',
        publishedAt: body.publishedAt || body.published_at || nowIso(),
      }, body.tenantId || '');
      return send(res, 200, { ok: true, ...payload });
    }

    if (req.method === 'POST' && requestUrl.pathname === '/publish/claim-next') {
      const body = await readBody(req);
      const apiBase = String(body.apiBase || '').replace(/\/$/, '');
      if (!apiBase) return send(res, 400, { error: 'apiBase is required' });
      const response = await fetch(`${apiBase}/publish-queue/claim-next`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(body.tenantId ? { 'x-naviwrite-tenant': body.tenantId } : {}),
        },
        body: JSON.stringify({
          platform: body.platform || null,
          publishAccountId: body.publishAccountId || null,
          publishAccountLabel: body.publishAccountLabel || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) return send(res, response.status, payload);
      if (payload.job && body.autoPlan !== false) {
        const planned = await requestRunnerPublishPlan({
          apiBase,
          tenantId: body.tenantId || '',
          job: payload.job,
          profile: {
            id: body.publishAccountId || payload.job.publish_account_id || '',
            label: body.publishAccountLabel || payload.job.publish_account_label || '',
            platform: body.platform || payload.job.publish_account_platform || payload.job.platform || '',
          },
          body,
        });
        payload.job = planned.job || payload.job;
        payload.publishPlan = planned.plan || null;
      }
      return send(res, 200, {
        ...payload,
        delayPlan: payload.job ? delayPlanForJob(payload.job) : null,
      });
    }

    if (req.method === 'POST' && requestUrl.pathname === '/publish/wordpress-job') {
      const body = await readBody(req);
      const job = body.job || {};
      const profileId = safeId(body.profileId || job.publish_account_id || '');
      const profile = profileId ? await readProfile(profileId) : null;
      if (!profile) return send(res, 404, { error: 'profile not found' });
      const prepared = await savePreparedPublishJob({ profile, job, editorUrl: editorUrlFor(profile, job) });
      if (!body.execute) {
        return send(res, 200, { ok: true, dryRun: true, prepared, delayPlan: delayPlanForJob(job) });
      }
      const published = await publishWordPressPost({ profile, job, status: body.wordpressStatus || body.status || '' });
      const apiBase = String(body.apiBase || '').replace(/\/$/, '');
      if (apiBase && job.id) {
        const publishStatus = published.wordpressStatus === 'publish'
          ? '발행완료'
          : published.wordpressStatus === 'future'
            ? '예약대기'
            : '초안대기';
        await fetch(`${apiBase}/publish-queue/${job.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...(body.tenantId ? { 'x-naviwrite-tenant': body.tenantId } : {}),
          },
          body: JSON.stringify({
            publishedUrl: published.link,
            publishStatus,
            publishedAt: published.wordpressStatus === 'publish' ? nowIso() : null,
          }),
        }).catch(() => null);
      }
      return send(res, 200, { ok: true, prepared, published });
    }

    if (req.method === 'GET' && requestUrl.pathname === '/profiles') {
      const store = await readStore();
      const profiles = await Promise.all(store.profiles.map(profilePayload));
      return send(res, 200, profiles);
    }

    if (req.method === 'POST' && requestUrl.pathname === '/profiles') {
      const profile = await upsertProfile(await readBody(req));
      return send(res, 200, {
        profile: await profilePayload(profile),
        plan: await loginPlanFor(profile),
      });
    }

    if (parts[0] === 'profiles' && parts[1]) {
      const id = safeId(parts[1]);

      if (req.method === 'PATCH' && parts.length === 2) {
        const profile = await updateProfile(id, await readBody(req));
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, {
          profile: await profilePayload(profile),
          plan: await loginPlanFor(profile),
        });
      }

      if (req.method === 'GET' && parts[2] === 'session-status') {
        const profile = await readProfile(id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, {
          profileId: id,
          session: sessionStatus(profile),
          credential: await credentialStatus(id),
          plan: await loginPlanFor(profile),
        });
      }

      if (req.method === 'GET' && parts[2] === 'login-plan') {
        const profile = await readProfile(id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, await loginPlanFor(profile));
      }

      if (req.method === 'POST' && parts[2] === 'startup-check') {
        const profile = await readProfile(id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, {
          ok: true,
          checkedAt: nowIso(),
          plan: await loginPlanFor(profile),
        });
      }

      if (req.method === 'POST' && parts[2] === 'open-login') {
        const profile = await readProfile(id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        const browser = findBrowserExecutable();
        if (!browser) return send(res, 500, { error: 'Chrome or Edge executable was not found.' });
        const child = spawn(browser, [
          `--user-data-dir=${profile.profilePath}`,
          '--no-first-run',
          '--disable-default-apps',
          loginUrlFor(profile),
        ], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        return send(res, 200, { ok: true, profileId: id, openedUrl: loginUrlFor(profile) });
      }

      if (req.method === 'POST' && parts[2] === 'discover-channel') {
        const profile = await readProfile(id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        const discovery = await discoverChannel(profile);
        const patch = {
          channelDiscovery: discovery,
          channelDiscoveredAt: nowIso(),
        };
        if (discovery.url) patch.targetUrl = discovery.url;
        const updated = await updateProfile(id, patch);
        return send(res, 200, {
          ok: discovery.ok,
          profileId: id,
          discovery,
          profile: updated ? await profilePayload(updated) : null,
          plan: updated ? await loginPlanFor(updated) : await loginPlanFor(profile),
        });
      }

      if (req.method === 'POST' && parts[2] === 'mark-login-checked') {
        const profile = await updateProfile(id, {
          loginStatus: '로그인됨',
          lastLoginCheckedAt: nowIso(),
          lastActivityAt: nowIso(),
        });
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, {
          profile: await profilePayload(profile),
          plan: await loginPlanFor(profile),
        });
      }

      if (req.method === 'POST' && parts[2] === 'activity') {
        const profile = await updateProfile(id, { lastActivityAt: nowIso() });
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, {
          profile: await profilePayload(profile),
          plan: await loginPlanFor(profile),
        });
      }

      if (req.method === 'GET' && parts[2] === 'credential-status') {
        const profile = await readProfile(id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, { profileId: id, credential: await credentialStatus(id) });
      }

      if (req.method === 'POST' && parts[2] === 'credentials' && parts[3] === 'verify') {
        const profile = await readProfile(id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        const file = credentialFileFor(id);
        if (!existsSync(file)) return send(res, 404, { error: 'credential not found' });
        const raw = JSON.parse(await fs.readFile(file, 'utf8'));
        await verifyEncryptedSecret(raw.encryptedPassword);
        raw.verifiedAt = nowIso();
        await fs.writeFile(file, JSON.stringify(raw, null, 2), 'utf8');
        return send(res, 200, { ok: true, profileId: id, credential: await credentialStatus(id) });
      }

      if (req.method === 'POST' && parts[2] === 'credentials' && parts.length === 3) {
        const body = await readBody(req);
        if (!body.username || !body.password) {
          return send(res, 400, { error: 'username and password are required' });
        }
        const encryptedPassword = await encryptSecretLocal(body.password);
        const credentialFile = credentialFileFor(id);
        await fs.writeFile(credentialFile, JSON.stringify({
          username: body.username,
          encryptedPassword,
          mode: 'windows-dpapi',
          updatedAt: nowIso(),
          verifiedAt: null,
        }, null, 2), 'utf8');
        const profile = await updateProfile(id, {
          usernameHint: body.username,
          credentialMode: 'dpapi',
          credentialKey: `naviwrite/${id}`,
        });
        return send(res, 200, {
          ok: true,
          profileId: id,
          profile: profile ? await profilePayload(profile) : null,
          credential: await credentialStatus(id),
          stored: 'local-windows-dpapi',
        });
      }

      if (req.method === 'DELETE' && parts[2] === 'credentials') {
        const profile = await readProfile(id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        const file = credentialFileFor(id);
        if (existsSync(file)) await fs.unlink(file);
        const updated = await updateProfile(id, {
          credentialMode: 'none',
          usernameHint: '',
        });
        return send(res, 200, {
          ok: true,
          profileId: id,
          profile: await profilePayload(updated),
          credential: await credentialStatus(id),
        });
      }
    }

    if (req.method === 'GET' && requestUrl.pathname === '/vpn/status') {
      return send(res, 200, {
        status: 'manual',
        message: 'VPN execution is manual/dry-run unless execute=true is explicitly requested.',
        time: nowIso(),
      });
    }

    if (req.method === 'POST' && requestUrl.pathname === '/vpn/connect') {
      const body = await readBody(req);
      const plan = vpnPlan(body);
      if (!body.execute) return send(res, 200, { ok: true, dryRun: true, plan });
      if (!plan.command.length || plan.followUpCommand?.length) {
        return send(res, 400, {
          error: 'This VPN profile is available as a manual execution plan only.',
          plan,
        });
      }
      const child = spawn(plan.command[0], plan.command.slice(1), { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return send(res, 200, { ok: true, dryRun: false, plan });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: err.message || 'runner error' });
  }
}

await ensureStore();

http.createServer(router).listen(PORT, '127.0.0.1', () => {
  console.log(`[NaviWrite Runner] http://127.0.0.1:${PORT}`);
  console.log(`[NaviWrite Runner] data: ${DATA_DIR}`);
  console.log(`[NaviWrite Runner] browser: ${findBrowserExecutable() || 'not found'}`);
});
