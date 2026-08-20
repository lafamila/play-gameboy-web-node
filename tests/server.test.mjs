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

async function withServer(callback, appOptions = {}) {
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
  const app = await createApp({ config, ...appOptions });
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

async function loginPlayer2(origin, accountId, permission) {
  const response = await fetch(`${origin}/__test/player2/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, permission, name: accountId }),
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  return {
    session,
    cookie: response.headers.get('set-cookie').split(';', 1)[0],
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

test('Player 2 login uses select_account and a separate state cookie', () => withServer(async ({ origin }) => {
  const login = await fetch(`${origin}/auth/player2/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get('location'));
  assert.equal(authorize.searchParams.get('prompt'), 'select_account');
  assert.match(login.headers.get('set-cookie'),
    /gbc_porting_player2_oidc_state=.*HttpOnly.*SameSite=Lax/);
  assert.doesNotMatch(login.headers.get('set-cookie'), /gbc_porting_oidc_state=/);
}));

test('Player 2 callback sets only the P2 cookie and returns a payload-free same-origin signal', async () => {
  const callbackCalls = [];
  const revoked = [];
  const fakeAuth = {
    async completeLogin(input) {
      callbackCalls.push(input);
      return {
        rawSessionId: 'player2-raw-session',
        purpose: 'player2',
        returnTo: '/',
        session: { subject: 'player-two-subject' },
      };
    },
    async getSession(raw) {
      return raw === 'player1-raw-session'
        ? { accountId: 'player-one', subject: 'player-one-subject', permission: 'user' }
        : null;
    },
    async logout(raw) { revoked.push(raw); },
  };
  await withServer(async ({ origin }) => {
    const response = await fetch(`${origin}/auth/callback?code=code&state=p2-state`, {
      headers: {
        Cookie: 'gbc_porting_session=player1-raw-session; gbc_porting_player2_session=old-player2; gbc_porting_player2_oidc_state=p2-state',
      },
    });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /gbc_porting_player2_session=player2-raw-session/);
    assert.doesNotMatch(setCookie, /gbc_porting_session=/);
    const body = await response.text();
    assert.match(body, /BroadcastChannel\('gbc-player2-auth'\)/);
    assert.match(body, /postMessage\(\{"type":"gbc-player2-auth-complete","ok":true\}\)/);
    assert.doesNotMatch(body, /window\.opener|location\.origin/);
    assert.doesNotMatch(body, /player-one|player-two|raw-session|access_token|refresh_token/i);
    assert.deepEqual(callbackCalls, [{ code: 'code', state: 'p2-state', stateCookie: 'p2-state' }]);
    assert.deepEqual(revoked, ['old-player2']);
  }, { auth: fakeAuth });
});

test('creating a replacement P2 test session revokes the previous app session', () => withServer(async ({ origin }) => {
  const first = await loginPlayer2(origin, 'replace-p2-old', 'user');
  const response = await fetch(`${origin}/__test/player2/session`, {
    method: 'POST',
    headers: { Cookie: first.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: 'replace-p2-new', permission: 'user' }),
  });
  assert.equal(response.status, 201);
  const secondCookie = response.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await fetch(`${origin}/api/player2/session`, {
    headers: { Cookie: first.cookie },
  }).then((item) => item.json())).authenticated, false);
  assert.equal((await fetch(`${origin}/api/player2/session`, {
    headers: { Cookie: secondCookie },
  }).then((item) => item.json())).account.id, 'replace-p2-new');
}));

test('same-account callback revokes both the previous and rejected P2 sessions', async () => {
  const revoked = [];
  const fakeAuth = {
    async completeLogin() {
      return { rawSessionId: 'rejected-new-p2', purpose: 'player2', returnTo: '/',
        session: { subject: 'primary-subject' } };
    },
    async getSession(raw) {
      return raw === 'primary-session'
        ? { accountId: 'primary', subject: 'primary-subject', permission: 'user' }
        : null;
    },
    async logout(raw) { revoked.push(raw); },
  };
  await withServer(async ({ origin }) => {
    const response = await fetch(`${origin}/auth/callback?code=code&state=p2-state`, {
      headers: { Cookie: 'gbc_porting_session=primary-session; ' +
        'gbc_porting_player2_session=previous-p2; gbc_porting_player2_oidc_state=p2-state' },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(revoked, ['previous-p2', 'rejected-new-p2']);
    assert.match(response.headers.get('set-cookie'), /gbc_porting_player2_session=.*Max-Age=0/);
  }, { auth: fakeAuth });
});

test('Player 2 session, access and logout remain isolated from Player 1', () => withServer(async ({ origin }) => {
  const player1 = await login(origin, 'player-one', 'user');
  const player2 = await loginPlayer2(origin, 'player-two', 'user');
  const cookie = `${player1.headers.Cookie}; ${player2.cookie}`;
  const p1Status = await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } }).then((item) => item.json());
  const p2Status = await fetch(`${origin}/api/player2/session`, { headers: { Cookie: cookie } }).then((item) => item.json());
  assert.equal(p1Status.account.id, 'player-one');
  assert.equal(p2Status.account.id, 'player-two');

  const logout = await fetch(`${origin}/auth/player2/logout`, {
    method: 'POST', headers: {
      Cookie: cookie,
      'X-CSRF-Token': player1.session.csrfToken,
      'X-Player2-CSRF-Token': player2.session.csrfToken,
    },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /gbc_porting_player2_session=.*Max-Age=0/);
  assert.doesNotMatch(logout.headers.get('set-cookie'), /gbc_porting_session=.*Max-Age=0/);
  assert.equal((await fetch(`${origin}/api/session`, {
    headers: { Cookie: player1.headers.Cookie },
  }).then((item) => item.json())).account.id, 'player-one');
}));

test('Player 2 visitor access requests require the P2 CSRF token, not the P1 token', () => withServer(async ({ origin }) => {
  const player1 = await login(origin, 'visitor-flow-player-one', 'user');
  const player2 = await loginPlayer2(origin, 'visitor-flow-player-two', 'visitor');
  const cookie = `${player1.headers.Cookie}; ${player2.cookie}`;
  assert.equal((await fetch(`${origin}/api/player2/access-request`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': player1.session.csrfToken },
  })).status, 403);
  const requested = await fetch(`${origin}/api/player2/access-request`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Player2-CSRF-Token': player2.session.csrfToken },
  });
  assert.equal(requested.status, 201);
  assert.equal((await requested.json()).application.status, 'pending');
  assert.equal((await fetch(`${origin}/api/session`, {
    headers: { Cookie: player1.headers.Cookie },
  }).then((response) => response.json())).account.id, 'visitor-flow-player-one');
}));

test('same-account Player 2 is cleared without replacing Player 1', () => withServer(async ({ origin }) => {
  const player1 = await login(origin, 'same-player', 'user');
  const player2 = await loginPlayer2(origin, 'same-player', 'user');
  const response = await fetch(`${origin}/api/player2/session`, {
    headers: { Cookie: `${player1.headers.Cookie}; ${player2.cookie}` },
  });
  assert.equal((await response.json()).authenticated, false);
  assert.match(response.headers.get('set-cookie'), /gbc_porting_player2_session=.*Max-Age=0/);
  assert.equal((await fetch(`${origin}/api/session`, {
    headers: { Cookie: player1.headers.Cookie },
  }).then((item) => item.json())).account.id, 'same-player');
}));

test('full logout revokes both app sessions and releases a preparing local pair', () => withServer(async ({ origin, app }) => {
  const player1 = await login(origin, 'full-logout-one', 'user');
  const player2 = await loginPlayer2(origin, 'full-logout-two', 'user');
  const cookie = `${player1.headers.Cookie}; ${player2.cookie}`;
  const rom = (await fetch(`${origin}/api/roms`, { headers: { Cookie: cookie } })
    .then((response) => response.json())).find((item) => item.platform === 'gba');
  assert.equal((await fetch(`${origin}/api/local-2p`, {
    method: 'POST',
    headers: {
      Cookie: cookie, 'X-CSRF-Token': player1.session.csrfToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      player2Mode: 'account', player1RomId: rom.id, player2RomId: rom.id,
    }),
  })).status, 201);
  assert.equal(app.database.localSaveLocks.size, 2);
  const logout = await fetch(`${origin}/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': player1.session.csrfToken },
  });
  assert.equal(logout.status, 200);
  const setCookie = logout.headers.get('set-cookie');
  assert.match(setCookie, /gbc_porting_session=.*Max-Age=0/);
  assert.match(setCookie, /gbc_porting_player2_session=.*Max-Age=0/);
  assert.equal(app.database.localSaveLocks.size, 0);
  assert.equal((await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })
    .then((response) => response.json())).authenticated, false);
  assert.equal((await fetch(`${origin}/api/player2/session`, { headers: { Cookie: cookie } })
    .then((response) => response.json())).authenticated, false);
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

test('full logout rejects a stale session without a valid CSRF context', () => withServer(async ({ origin }) => {
  const response = await fetch(`${origin}/auth/logout`, {
    method: 'POST',
    headers: { Cookie: 'gbc_porting_session=stale-session' },
  });
  assert.equal(response.status, 401);
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

test('local 2P account and guest profiles are isolated and paired persistence blocks remote Rooms', () => withServer(async ({ origin }) => {
  const player1 = await login(origin, 'local-player-one', 'user');
  const player2 = await loginPlayer2(origin, 'local-player-two', 'user');
  const cookie = `${player1.headers.Cookie}; ${player2.cookie}`;
  const headers = {
    Cookie: cookie,
    'X-CSRF-Token': player1.session.csrfToken,
    'X-Player2-CSRF-Token': player2.session.csrfToken,
  };
  const roms = await fetch(`${origin}/api/roms`, { headers }).then((response) => response.json());
  const rom = roms.find((item) => item.platform === 'gba');
  const primaryBattery = Buffer.alloc(131072, 0x10);
  const guestBattery = Buffer.alloc(131072, 0x20);
  const player2Battery = Buffer.alloc(131072, 0x30);
  assert.equal((await fetch(`${origin}/api/saves/${rom.id}/battery`, {
    method: 'PUT', headers, body: primaryBattery,
  })).status, 200);
  assert.equal((await fetch(`${origin}/api/player2/guest/saves/${rom.id}/battery`, {
    method: 'PUT', headers, body: guestBattery,
  })).status, 200);
  assert.equal((await fetch(`${origin}/api/player2/account/saves/${rom.id}/battery`, {
    method: 'PUT', headers, body: player2Battery,
  })).status, 200);
  assert.deepEqual(Buffer.from(await fetch(`${origin}/api/saves/${rom.id}/battery`, {
    headers,
  }).then((response) => response.arrayBuffer())), primaryBattery);
  assert.deepEqual(Buffer.from(await fetch(`${origin}/api/player2/guest/saves/${rom.id}/battery`, {
    headers,
  }).then((response) => response.arrayBuffer())), guestBattery);
  assert.deepEqual(Buffer.from(await fetch(`${origin}/api/player2/account/saves/${rom.id}/battery`, {
    headers,
  }).then((response) => response.arrayBuffer())), player2Battery);

  const created = await fetch(`${origin}/api/local-2p`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      player2Mode: 'account', player1RomId: rom.id, player2RomId: rom.id,
    }),
  });
  assert.equal(created.status, 201);
  const localSession = (await created.json()).session;
  assert.equal((await fetch(`${origin}/api/link/rooms`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ romId: rom.id }),
  })).status, 409);
  for (const [action, readyHeaders] of [
    ['player1-ready', headers],
    ['player2-ready', headers],
  ]) {
    assert.equal((await fetch(`${origin}/api/local-2p/${localSession.id}/${action}`, {
      method: 'POST', headers: { ...readyHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ready: true }),
    })).status, 200);
  }
  assert.equal((await fetch(`${origin}/api/local-2p/${localSession.id}/checkpoint`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sequence: 0, states: [
      { slot: 0, data: Buffer.from('paired-state-one').toString('base64') },
      { slot: 1, data: Buffer.from('paired-state-two').toString('base64') },
    ] }),
  })).status, 200);
  assert.equal((await fetch(`${origin}/api/local-2p/${localSession.id}/start`, {
    method: 'POST', headers,
  })).status, 200);
  const finalOne = Buffer.alloc(131072, 0x41);
  const finalTwo = Buffer.alloc(131072, 0x42);
  assert.equal((await fetch(`${origin}/api/local-2p/${localSession.id}/finish`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ batteries: [
      { slot: 0, data: finalOne.toString('base64') },
      { slot: 1, data: finalTwo.toString('base64') },
    ] }),
  })).status, 200);
  assert.deepEqual(Buffer.from(await fetch(`${origin}/api/saves/${rom.id}/battery`, {
    headers,
  }).then((response) => response.arrayBuffer())), finalOne);
  assert.deepEqual(Buffer.from(await fetch(`${origin}/api/player2/account/saves/${rom.id}/battery`, {
    headers,
  }).then((response) => response.arrayBuffer())), finalTwo);
  assert.deepEqual(Buffer.from(await fetch(`${origin}/api/player2/guest/saves/${rom.id}/battery`, {
    headers,
  }).then((response) => response.arrayBuffer())), guestBattery);
}));

test('P2 logout requires both CSRF slots and never performs account-wide local cleanup', () => withServer(async ({ origin, app }) => {
  const player1 = await login(origin, 'logout-owner', 'user');
  const player2 = await loginPlayer2(origin, 'logout-player2', 'user');
  const cookie = `${player1.headers.Cookie}; ${player2.cookie}`;
  const rom = (await fetch(`${origin}/api/roms`, { headers: { Cookie: cookie } })
    .then((response) => response.json())).find((item) => item.platform === 'gba');
  const created = await fetch(`${origin}/api/local-2p`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': player1.session.csrfToken,
      'Content-Type': 'application/json' },
    body: JSON.stringify({ player2Mode: 'account', player1RomId: rom.id, player2RomId: rom.id }),
  });
  const local = (await created.json()).session;
  app.database.localLinkSessions.set('unrelated-local', {
    id: 'unrelated-local', ownerAccountId: 'another-owner',
    player2AccountId: 'logout-player2', player2Mode: 'account', status: 'preparing',
    leaseExpiresAt: Date.now() + 60_000, createdAt: Date.now(), updatedAt: Date.now(),
    lastCheckpointSequence: -1, guestHandshakePending: false,
    lastPairSequence: -1, lastReleaseSequence: -1,
  });
  assert.equal((await fetch(`${origin}/auth/player2/logout`, {
    method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': player1.session.csrfToken },
  })).status, 403);
  assert.equal((await fetch(`${origin}/auth/player2/logout`, {
    method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': player1.session.csrfToken,
      'X-Player2-CSRF-Token': player2.session.csrfToken },
  })).status, 200);
  assert.equal((await app.database.getLocalLinkSession(local.id)).status, 'aborted');
  assert.equal(app.database.localSaveLocks.size, 0);
  assert.equal(app.database.playAdmissionLocks.size, 0);
  assert.equal((await app.database.getLocalLinkSession('unrelated-local')).status, 'preparing');
}));

test('local recovery is POST+CSRF and account-mode operations revalidate current P2 permission', () => withServer(async ({ origin, app }) => {
  const player1 = await login(origin, 'permission-owner', 'user');
  const player2 = await loginPlayer2(origin, 'permission-player2', 'user');
  const cookie = `${player1.headers.Cookie}; ${player2.cookie}`;
  const rom = (await fetch(`${origin}/api/roms`, { headers: { Cookie: cookie } })
    .then((response) => response.json())).find((item) => item.platform === 'gba');
  const local = (await fetch(`${origin}/api/local-2p`, {
    method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': player1.session.csrfToken,
      'Content-Type': 'application/json' },
    body: JSON.stringify({ player2Mode: 'account', player1RomId: rom.id, player2RomId: rom.id }),
  }).then((response) => response.json())).session;
  assert.notEqual((await fetch(`${origin}/api/local-2p/recover`, {
    headers: { Cookie: cookie },
  })).status, 200);
  assert.equal((await fetch(`${origin}/api/local-2p/recover`, {
    method: 'POST', headers: { Cookie: cookie },
  })).status, 403);
  const visitorReplacement = await fetch(`${origin}/__test/player2/session`, {
    method: 'POST', headers: { Cookie: player2.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: 'permission-player2', permission: 'visitor' }),
  });
  const visitorCookie = visitorReplacement.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await fetch(`${origin}/api/local-2p/${local.id}/heartbeat`, {
    method: 'POST', headers: { Cookie: `${player1.headers.Cookie}; ${visitorCookie}`,
      'X-CSRF-Token': player1.session.csrfToken },
  })).status, 403);
  await app.localLinkService.abort({ id: local.id, player1: {
    accountId: 'permission-owner', permission: 'user', subject: 'permission-owner',
  } });
}));
