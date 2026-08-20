import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';

import { createConfig } from '../lib/config.mjs';
import { buildAuthLogoutUrl, createApp } from '../server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');

async function withServer(callback) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'play-gameboy-web-node-test-'));
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
  const origin = `http://127.0.0.1:${port}`;
  app.config.publicBaseUrl = origin;
  try {
    await callback({ origin, app });
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

function waitForSocketMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5000);
    const onMessage = (payload) => {
      const message = JSON.parse(payload.toString('utf8'));
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function openLinkSocket(origin, roomId, cookie) {
  const socket = new WebSocket(
    `${origin.replace(/^http/, 'ws')}/api/link/rooms/${roomId}/socket`,
    { headers: { Cookie: cookie, Origin: origin } },
  );
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

test('full logout URL clears the auth SSO session and returns to the public app', () => {
  const url = new URL(buildAuthLogoutUrl({
    authPublicBaseUrl: 'https://auth.lafamila.xyz',
    publicBaseUrl: 'https://play.lafamila.xyz',
  }));
  assert.equal(url.toString(), 'https://auth.lafamila.xyz/logout?return_to=https%3A%2F%2Fplay.lafamila.xyz%2F');
});

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
  assert.equal((await logout.json()).authLogoutUrl, '/');
}));

test('logout is idempotent and clears local cookies without refreshing a stale session', () => withServer(async ({ origin }) => {
  const response = await fetch(`${origin}/auth/logout`, {
    method: 'POST',
    headers: { Cookie: 'gbc_porting_session=stale-session' },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.match(response.headers.get('set-cookie'), /gbc_porting_session=.*Max-Age=0/);
  assert.match(response.headers.get('set-cookie'), /gbc_porting_oidc_state=.*Max-Age=0/);
  assert.equal(result.authLogoutUrl, '/');
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

test('admin can play and manage save files but cannot upload ROMs or use reference fixtures', () => withServer(async ({ origin }) => {
  const admin = await login(origin, 'save-admin-account', 'admin');
  const romsResponse = await fetch(`${origin}/api/roms`, { headers: admin.headers });
  assert.equal(romsResponse.status, 200);
  const [rom] = await romsResponse.json();
  assert.equal((await fetch(`${origin}/api/fixtures`, { headers: admin.headers })).status, 403);
  assert.equal((await fetch(`${origin}/api/roms`, {
    method: 'POST', headers: { ...admin.headers, 'X-Filename': 'admin.gba' }, body: await fixture('.gba'),
  })).status, 403);
  const state = await fixture('.sg1', '1.sg1');
  assert.equal((await fetch(`${origin}/api/saves/${rom.id}/state`, {
    method: 'PUT', headers: admin.headers, body: state,
  })).status, 200);
  assert.deepEqual(
    Buffer.from(await fetch(`${origin}/api/saves/${rom.id}/state`, {
      headers: admin.headers,
    }).then((response) => response.arrayBuffer())),
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
  assert.equal((await fetch(`${origin}/core/V172lsrc.zip`)).status, 200);
}));

test('two authenticated browser sessions exchange a cable word and atomically commit batteries', () => withServer(async ({ origin }) => {
  const host = await login(origin, 'link-host', 'user');
  const guest = await login(origin, 'link-guest', 'user');
  const roms = await fetch(`${origin}/api/roms`, { headers: host.headers }).then((response) => response.json());
  const rom = roms.find((item) => item.platform === 'gba');
  assert.ok(rom);

  const createdResponse = await fetch(`${origin}/api/link/rooms`, {
    method: 'POST',
    headers: { ...host.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ romId: rom.id }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const roomId = created.room.id;

  const joined = await fetch(`${origin}/api/link/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { ...guest.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ romId: rom.id, inviteCode: created.inviteCode }),
  });
  assert.equal(joined.status, 200);
  for (const actor of [host, guest]) {
    const ready = await fetch(`${origin}/api/link/rooms/${roomId}/ready`, {
      method: 'POST',
      headers: { ...actor.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ready: true }),
    });
    assert.equal(ready.status, 200);
  }
  const started = await fetch(`${origin}/api/link/rooms/${roomId}/start`, {
    method: 'POST', headers: host.headers,
  });
  assert.equal(started.status, 200);

  const hostSocket = await openLinkSocket(origin, roomId, host.headers.Cookie);
  const guestSocket = await openLinkSocket(origin, roomId, guest.headers.Cookie);
  try {
    const offer = waitForSocketMessage(guestSocket, 'link-offer');
    const hostPair = waitForSocketMessage(hostSocket, 'link-pair');
    const guestPair = waitForSocketMessage(guestSocket, 'link-pair');
    hostSocket.send(JSON.stringify({ type: 'link-offer', sequence: 0, speed: 3, data: 0x1234, ticks: 0 }));
    assert.deepEqual(await offer, { type: 'link-offer', sequence: 0, speed: 3, data: 0x1234, ticks: 0 });
    guestSocket.send(JSON.stringify({
      type: 'link-response', sequence: 0, speed: 3, data: 0xabcd, ticks: 0,
    }));
    assert.deepEqual(await hostPair, {
      type: 'link-pair', sequence: 0, speed: 3, ticks: 0, masterData: 0x1234, slaveData: 0xabcd,
    });
    assert.deepEqual(await guestPair, {
      type: 'link-pair', sequence: 0, speed: 3, ticks: 0, masterData: 0x1234, slaveData: 0xabcd,
    });

    const battery = await fixture('.sa1');
    const first = await fetch(`${origin}/api/link/rooms/${roomId}/battery`, {
      method: 'POST', headers: host.headers, body: battery,
    });
    assert.equal((await first.json()).status, 'finishing');
    const second = await fetch(`${origin}/api/link/rooms/${roomId}/battery`, {
      method: 'POST', headers: guest.headers, body: battery,
    });
    assert.equal((await second.json()).status, 'completed');
    assert.equal((await fetch(`${origin}/api/saves/${rom.id}/battery`, { headers: host.headers })).status, 200);
    assert.equal((await fetch(`${origin}/api/saves/${rom.id}/battery`, { headers: guest.headers })).status, 200);
  } finally {
    hostSocket.close();
    guestSocket.close();
  }
}));
