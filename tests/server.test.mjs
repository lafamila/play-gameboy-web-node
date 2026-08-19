import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConfig } from '../lib/config.mjs';
import { createApp } from '../server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');

async function withServer(callback) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gbc-porting-test-'));
  const config = createConfig({
    root: ROOT,
    nodeEnv: 'test',
    authTestMode: true,
    database: { driver: 'memory' },
    sessionEncryptionKey: 'test-session-encryption-key',
    romStorageDir: path.join(temporaryRoot, 'roms'),
    fixtureDir: DATA,
    publicBaseUrl: 'http://127.0.0.1',
    secureCookies: false,
  });
  const app = await createApp({ config });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  try {
    await callback({ origin: `http://127.0.0.1:${port}`, app });
  } finally {
    await app.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function login(origin, accountId, permission) {
  const response = await fetch(`${origin}/__test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, permission, name: accountId }),
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  return {
    session,
    headers: {
      Cookie: response.headers.get('set-cookie').split(';', 1)[0],
      'X-CSRF-Token': session.csrfToken,
    },
  };
}

async function fixture(extension, includes = '') {
  const filename = (await readdir(DATA)).find((name) => name.endsWith(extension) && name.includes(includes));
  return readFile(path.join(DATA, filename));
}

test('unauthenticated clients can render login shell but cannot read ROM data', () => withServer(async ({ origin }) => {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal((await fetch(`${origin}/api/session`).then((response) => response.json())).authenticated, false);
  assert.equal((await fetch(`${origin}/api/roms`)).status, 401);
  const login = await fetch(`${origin}/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.match(login.headers.get('location'), /^http:\/\/localhost:3032\/oauth\/authorize\?/);
  assert.match(login.headers.get('set-cookie'), /gbc_porting_oidc_state=.*HttpOnly.*SameSite=Lax/);
  const forcedLogin = await fetch(`${origin}/auth/login?prompt=login`, { redirect: 'manual' });
  assert.equal(forcedLogin.status, 302);
  assert.equal(new URL(forcedLogin.headers.get('location')).searchParams.get('prompt'), 'login');
}));

test('visitor sees only access request APIs and CSRF is enforced', () => withServer(async ({ origin }) => {
  const visitor = await login(origin, 'visitor-account', 'visitor');
  assert.equal((await fetch(`${origin}/api/roms`, { headers: visitor.headers })).status, 403);
  assert.equal((await fetch(`${origin}/api/access-request`, { headers: visitor.headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/access-request`, {
    method: 'POST', headers: { Cookie: visitor.headers.Cookie },
  })).status, 403);
  const requested = await fetch(`${origin}/api/access-request`, {
    method: 'POST', headers: visitor.headers,
  });
  assert.equal(requested.status, 201);
  assert.equal((await requested.json()).application.status, 'pending');
  const logout = await fetch(`${origin}/auth/logout`, { method: 'POST', headers: visitor.headers });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /gbc_porting_force_login=1/);
  const nextLogin = await fetch(`${origin}/auth/login`, {
    redirect: 'manual',
    headers: { Cookie: 'gbc_porting_force_login=1' },
  });
  assert.equal(new URL(nextLogin.headers.get('location')).searchParams.get('prompt'), 'login');
}));

test('user can play and save but cannot upload ROMs or read reference save files', () => withServer(async ({ origin }) => {
  const user = await login(origin, 'user-account', 'user');
  const romsResponse = await fetch(`${origin}/api/roms`, { headers: user.headers });
  assert.equal(romsResponse.status, 200);
  const [rom] = await romsResponse.json();
  assert.equal((await fetch(`${origin}/api/roms/${rom.id}/file`, { headers: user.headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/fixtures`, { headers: user.headers })).status, 403);
  assert.equal((await fetch(`${origin}/api/roms`, {
    method: 'POST', headers: { ...user.headers, 'X-Filename': 'game.gba' }, body: await fixture('.gba'),
  })).status, 403);

  const state = await fixture('.sg1', '1.sg1');
  const battery = await fixture('.sa1');
  assert.equal((await fetch(`${origin}/api/saves/${rom.id}/state`, {
    method: 'PUT', headers: user.headers, body: state,
  })).status, 200);
  assert.equal((await fetch(`${origin}/api/saves/${rom.id}/battery`, {
    method: 'PUT', headers: user.headers, body: battery,
  })).status, 200);
  assert.deepEqual(
    Buffer.from(await fetch(`${origin}/api/saves/${rom.id}/state`, { headers: user.headers }).then((response) => response.arrayBuffer())),
    state,
  );
}));

test('save rows are isolated by account even for the same ROM', () => withServer(async ({ origin }) => {
  const first = await login(origin, 'account-a', 'user');
  const second = await login(origin, 'account-b', 'user');
  const [rom] = await fetch(`${origin}/api/roms`, { headers: first.headers }).then((response) => response.json());
  const stateA = await fixture('.sg1', '1.sg1');
  const stateB = await fixture('.sg1', '2.sg1');
  await fetch(`${origin}/api/saves/${rom.id}/state`, { method: 'PUT', headers: first.headers, body: stateA });
  assert.equal((await fetch(`${origin}/api/saves/${rom.id}/state`, { headers: second.headers })).status, 404);
  await fetch(`${origin}/api/saves/${rom.id}/state`, { method: 'PUT', headers: second.headers, body: stateB });
  const loadedA = Buffer.from(await fetch(`${origin}/api/saves/${rom.id}/state`, { headers: first.headers }).then((response) => response.arrayBuffer()));
  const loadedB = Buffer.from(await fetch(`${origin}/api/saves/${rom.id}/state`, { headers: second.headers }).then((response) => response.arrayBuffer()));
  assert.deepEqual(loadedA, stateA);
  assert.deepEqual(loadedB, stateB);
  assert.notDeepEqual(loadedA, loadedB);
}));

test('superadmin can upload ROMs and access save-file fixtures', () => withServer(async ({ origin }) => {
  const admin = await login(origin, 'admin-account', 'superadmin');
  const rom = await fixture('.gba');
  const upload = await fetch(`${origin}/api/roms`, {
    method: 'POST',
    headers: { ...admin.headers, 'X-Filename': encodeURIComponent('관리용 게임.gba') },
    body: rom,
  });
  assert.equal(upload.status, 201);
  assert.equal((await upload.json()).gameCode, 'BPRE');
  const gbUpload = await fetch(`${origin}/api/roms`, {
    method: 'POST',
    headers: { ...admin.headers, 'X-Filename': 'Red_K.gb' },
    body: await readFile(path.join(ROOT, 'Red_K.gb')),
  });
  assert.equal(gbUpload.status, 201);
  const gb = await gbUpload.json();
  assert.equal(gb.platform, 'gb');
  assert.equal(gb.title, 'POKEMON RED');
  assert.equal(gb.gameCode, 'GB');
  const catalog = await fetch(`${origin}/api/roms`, { headers: admin.headers }).then((response) => response.json());
  assert.ok(catalog.some((rom) => rom.platform === 'gb' && rom.title === 'POKEMON RED'));
  const fixtureResponse = await fetch(`${origin}/api/fixtures`, { headers: admin.headers });
  assert.equal(fixtureResponse.status, 200);
  const fixtures = await fixtureResponse.json();
  assert.equal(fixtures.filter((item) => item.type === 'state').length, 3);
  assert.equal(fixtures.filter((item) => item.type === 'battery').length, 1);
}));

test('static WebAssembly keeps isolation headers and source archive', () => withServer(async ({ origin }) => {
  const wasm = await fetch(`${origin}/core/vba172.wasm`);
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal(wasm.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal((await fetch(`${origin}/core/VisualBoyAdvance-src-1.7.2.zip`)).status, 200);
}));
