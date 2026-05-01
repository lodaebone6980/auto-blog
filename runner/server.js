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
const STORE_FILE = path.join(DATA_DIR, 'profiles.json');
const LOGIN_CHECK_INTERVAL_MS = Number(process.env.NAVIWRITE_LOGIN_CHECK_MS || 6 * 60 * 60 * 1000);
const INACTIVITY_RECHECK_MS = Number(process.env.NAVIWRITE_INACTIVITY_RECHECK_MS || 2 * 60 * 60 * 1000);

function nowIso() {
  return new Date().toISOString();
}

function safeId(value) {
  return String(value || `profile_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

async function ensureStore() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
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
  return 'https://nid.naver.com/nidlogin.login';
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
    throw new Error('현재 로컬 암호화 저장은 Windows DPAPI에서만 지원됩니다');
  }
  return runPowerShell('$s=ConvertTo-SecureString $env:NAVIWRITE_SECRET -AsPlainText -Force; ConvertFrom-SecureString $s', {
    NAVIWRITE_SECRET: secret,
  });
}

function vpnPlan({ provider = 'nordvpn', target = '', execute = false }) {
  if (provider === 'nordvpn') {
    return {
      provider,
      execute,
      command: target ? ['nordvpn', '-c', '-g', target] : ['nordvpn', '-c'],
    };
  }
  if (provider === 'mullvad') {
    return {
      provider,
      execute,
      command: target ? ['mullvad', 'relay', 'set', 'location', target, '&&', 'mullvad', 'connect'] : ['mullvad', 'connect'],
    };
  }
  return { provider: 'manual', execute: false, command: [] };
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
        version: '0.1.0',
        dataDir: DATA_DIR,
        profileDir: PROFILE_DIR,
        browserFound: Boolean(findBrowserExecutable()),
        time: nowIso(),
      });
    }

    if (req.method === 'GET' && requestUrl.pathname === '/profiles') {
      const store = await readStore();
      return send(res, 200, store.profiles.map((profile) => ({
        ...profile,
        session: sessionStatus(profile),
        hasCredential: profile.credentialMode === 'dpapi',
      })));
    }

    if (req.method === 'POST' && requestUrl.pathname === '/profiles') {
      const profile = await upsertProfile(await readBody(req));
      return send(res, 200, { profile, session: sessionStatus(profile) });
    }

    if (parts[0] === 'profiles' && parts[1]) {
      const id = parts[1];

      if (req.method === 'PATCH' && parts.length === 2) {
        const profile = await updateProfile(id, await readBody(req));
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, { profile, session: sessionStatus(profile) });
      }

      if (req.method === 'GET' && parts[2] === 'session-status') {
        const store = await readStore();
        const profile = store.profiles.find((item) => item.id === id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, { profileId: id, session: sessionStatus(profile) });
      }

      if (req.method === 'POST' && parts[2] === 'open-login') {
        const store = await readStore();
        const profile = store.profiles.find((item) => item.id === id);
        if (!profile) return send(res, 404, { error: 'profile not found' });
        const browser = findBrowserExecutable();
        if (!browser) return send(res, 500, { error: 'Chrome 또는 Edge 실행 파일을 찾지 못했습니다' });
        const child = spawn(browser, [
          `--user-data-dir=${profile.profilePath}`,
          '--no-first-run',
          '--disable-default-apps',
          loginUrlFor(profile),
        ], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        return send(res, 200, { ok: true, profileId: id, openedUrl: loginUrlFor(profile) });
      }

      if (req.method === 'POST' && parts[2] === 'mark-login-checked') {
        const profile = await updateProfile(id, {
          loginStatus: '로그인됨',
          lastLoginCheckedAt: nowIso(),
          lastActivityAt: nowIso(),
        });
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, { profile, session: sessionStatus(profile) });
      }

      if (req.method === 'POST' && parts[2] === 'activity') {
        const profile = await updateProfile(id, { lastActivityAt: nowIso() });
        if (!profile) return send(res, 404, { error: 'profile not found' });
        return send(res, 200, { profile, session: sessionStatus(profile) });
      }

      if (req.method === 'POST' && parts[2] === 'credentials') {
        const body = await readBody(req);
        if (!body.username || !body.password) return send(res, 400, { error: 'username and password are required' });
        const encryptedPassword = await encryptSecretLocal(body.password);
        const credentialFile = path.join(DATA_DIR, `${id}.credential.json`);
        await fs.writeFile(credentialFile, JSON.stringify({
          username: body.username,
          encryptedPassword,
          mode: 'windows-dpapi',
          updatedAt: nowIso(),
        }, null, 2), 'utf8');
        const profile = await updateProfile(id, {
          usernameHint: body.username,
          credentialMode: 'dpapi',
          credentialKey: `naviwrite/${id}`,
        });
        return send(res, 200, { ok: true, profileId: id, profile, stored: 'local-dpapi' });
      }
    }

    if (req.method === 'GET' && requestUrl.pathname === '/vpn/status') {
      return send(res, 200, {
        status: 'manual',
        message: 'VPN 제어는 수동 승인 또는 execute=true 요청에서만 실행됩니다',
        time: nowIso(),
      });
    }

    if (req.method === 'POST' && requestUrl.pathname === '/vpn/connect') {
      const body = await readBody(req);
      const plan = vpnPlan(body);
      if (!body.execute) return send(res, 200, { ok: true, dryRun: true, plan });
      if (!plan.command.length || plan.command.includes('&&')) {
        return send(res, 400, { error: '이 VPN 명령은 수동 실행 계획만 제공합니다', plan });
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
