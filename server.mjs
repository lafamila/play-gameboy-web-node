import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { AuthClient, AuthError } from './lib/auth.mjs';
import { createConfig } from './lib/config.mjs';
import { createDatabase } from './lib/database.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, 'web');
const CORE_ROOT = path.join(ROOT, 'core', 'dist');
const FORCE_LOGIN_COOKIE = 'gbc_porting_force_login';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.zip', 'application/zip'],
  ['.gba', 'application/octet-stream'],
  ['.sg1', 'application/gzip'],
  ['.sa1', 'application/octet-stream'],
]);

export async function createApp(options = {}) {
  const config = options.config ?? createConfig({ root: ROOT });
  const database = options.database ?? await createDatabase(config.database, { allowMemory: config.authTestMode });
  const auth = options.auth ?? new AuthClient(config, database);
  await mkdir(config.romStorageDir, { recursive: true });
  await syncRomCatalog(config, database);

  const server = createServer((request, response) => {
    void handleRequest({ request, response, config, database, auth }).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const statusCode = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
      json(response, statusCode, { error: statusCode === 500 ? 'Server error' : error.message });
      if (statusCode === 500) console.error(error);
    });
  });
  return {
    server,
    config,
    database,
    auth,
    close: async () => {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await database.close();
    },
  };
}

async function handleRequest(context) {
  const { request, response, config, database, auth } = context;
  const url = new URL(request.url, config.publicBaseUrl);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return json(response, 200, { status: 'ok' });
  }

  if (request.method === 'GET' && url.pathname === '/auth/login') {
    const login = await auth.startLogin(
      url.searchParams.get('return_to') ?? '/',
      url.searchParams.get('prompt') === 'login' || cookies(request)[FORCE_LOGIN_COOKIE] === '1',
    );
    setCookie(response, 'gbc_porting_oidc_state', login.state, {
      maxAgeSeconds: config.oidcTransactionTtlSeconds,
      secure: config.secureCookies,
    });
    return redirect(response, login.authorizeUrl);
  }

  if (request.method === 'GET' && url.pathname === '/auth/callback') {
    if (url.searchParams.get('error')) {
      throw new AuthError(401, url.searchParams.get('error_description') ?? url.searchParams.get('error'));
    }
    const result = await auth.completeLogin({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      stateCookie: cookies(request).gbc_porting_oidc_state,
    });
    clearCookie(response, 'gbc_porting_oidc_state', config.secureCookies);
    clearCookie(response, FORCE_LOGIN_COOKIE, config.secureCookies);
    setCookie(response, config.sessionCookieName, result.rawSessionId, {
      maxAgeSeconds: config.sessionMaxAgeSeconds,
      secure: config.secureCookies,
    });
    return redirect(response, result.returnTo);
  }

  if (request.method === 'POST' && url.pathname === '/__test/session') {
    if (!config.authTestMode) throw new AuthError(404, 'Not found');
    const body = JSON.parse((await readRequest(request, 32 * 1024)).toString('utf8'));
    const result = await auth.createTestSession({
      accountId: String(body.accountId || 'test-account'),
      permission: body.permission,
      name: body.name,
      email: body.email,
    });
    setCookie(response, config.sessionCookieName, result.rawSessionId, {
      maxAgeSeconds: config.sessionMaxAgeSeconds,
      secure: false,
    });
    return json(response, 201, publicSession(result.session));
  }

  const session = await auth.getSession(cookies(request)[config.sessionCookieName]);

  if (request.method === 'GET' && url.pathname === '/api/session') {
    return json(response, 200, session
      ? { authenticated: true, ...publicSession(session) }
      : { authenticated: false });
  }

  if (request.method === 'POST' && url.pathname === '/auth/logout') {
    requireSession(session);
    requireCsrf(request, session, config);
    await auth.logout(session.rawSessionId);
    clearCookie(response, config.sessionCookieName, config.secureCookies);
    setCookie(response, FORCE_LOGIN_COOKIE, '1', {
      maxAgeSeconds: 10 * 60,
      secure: config.secureCookies,
    });
    return json(response, 200, { ok: true });
  }

  if (url.pathname === '/api/access-request') {
    requirePermission(session, ['visitor']);
    if (request.method === 'GET') {
      const application = await database.getAccessRequest(session.accountId);
      return json(response, 200, { application });
    }
    if (request.method === 'POST') {
      requireCsrf(request, session, config);
      const application = await auth.requestAccess(session);
      return json(response, 201, { application });
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/roms') {
    requirePermission(session, ['user', 'superadmin']);
    return json(response, 200, await database.listRoms());
  }

  if (request.method === 'POST' && url.pathname === '/api/roms') {
    requirePermission(session, ['superadmin']);
    requireCsrf(request, session, config);
    const body = await readRequest(request, config.maxRomBytes);
    const requestedName = cleanFilename(decodeFilenameHeader(request.headers['x-filename']));
    const record = parseRom(body, requestedName, 'uploaded');
    const storedName = `${record.id.slice(0, 12)}-${requestedName}`;
    const storedPath = path.join(config.romStorageDir, storedName);
    await writeFile(storedPath, body, { flag: 'wx' }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await database.upsertRom({ ...record, filename: storedName, path: storedPath, createdBy: session.accountId });
    return json(response, 201, { ...record, filename: storedName });
  }

  const romMatch = url.pathname.match(/^\/api\/roms\/([a-f0-9]{64})\/file$/);
  if (request.method === 'GET' && romMatch) {
    requirePermission(session, ['user', 'superadmin']);
    const rom = await database.getRom(romMatch[1]);
    if (!rom) throw new AuthError(404, 'ROM not found');
    return sendFile(response, rom.path, 'private, no-store');
  }

  if (request.method === 'GET' && url.pathname === '/api/fixtures') {
    requirePermission(session, ['superadmin']);
    const fixtures = await scanFixtures(config.fixtureDir);
    return json(response, 200, fixtures.map(({ path: _path, ...record }) => record));
  }

  const fixtureMatch = url.pathname.match(/^\/api\/fixtures\/([a-f0-9]{20})\/file$/);
  if (request.method === 'GET' && fixtureMatch) {
    requirePermission(session, ['superadmin']);
    const fixture = (await scanFixtures(config.fixtureDir)).find((item) => item.id === fixtureMatch[1]);
    if (!fixture) throw new AuthError(404, 'Fixture not found');
    return sendFile(response, fixture.path, 'private, no-store');
  }

  const saveMetaMatch = url.pathname.match(/^\/api\/saves\/([a-f0-9]{64})\/meta$/);
  if (request.method === 'GET' && saveMetaMatch) {
    requirePermission(session, ['user', 'superadmin']);
    const rom = await database.getRom(saveMetaMatch[1]);
    if (!rom) throw new AuthError(404, 'ROM not found');
    return json(response, 200, { saves: await database.getSaveMetadata(session.accountId, rom.id) });
  }

  const saveMatch = url.pathname.match(/^\/api\/saves\/([a-f0-9]{64})\/(state|battery)$/);
  if (saveMatch) {
    requirePermission(session, ['user', 'superadmin']);
    const [, romId, kind] = saveMatch;
    const rom = await database.getRom(romId);
    if (!rom) throw new AuthError(404, 'ROM not found');
    if (request.method === 'GET') {
      const save = await database.getSave(session.accountId, romId, kind);
      if (!save) throw new AuthError(404, 'Save not found');
      return binary(response, 200, Buffer.from(save.payload), kind === 'state' ? 'application/gzip' : 'application/octet-stream', {
        'X-Save-Updated-At': String(save.updatedAt ?? save.updated_at),
      });
    }
    if (request.method === 'PUT') {
      requireCsrf(request, session, config);
      const payload = await readRequest(request, config.maxSaveBytes);
      if (kind === 'state') validateState(payload, rom);
      else validateBattery(payload);
      await database.putSave(session.accountId, romId, kind, payload);
      return json(response, 200, { ok: true, size: payload.length, updatedAt: Date.now() });
    }
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new AuthError(405, 'Method not allowed');
  }

  if (url.pathname.startsWith('/core/')) {
    const filename = safeStaticPath(CORE_ROOT, url.pathname.slice('/core/'.length));
    if (!filename) throw new AuthError(400, 'Invalid path');
    return sendFile(response, filename, 'no-cache');
  }

  const pathname = url.pathname === '/' ? 'index.html' : url.pathname;
  const filename = safeStaticPath(WEB_ROOT, pathname);
  if (!filename) throw new AuthError(400, 'Invalid path');
  return sendFile(response, filename);
}

function requireSession(session) {
  if (!session) throw new AuthError(401, 'Login required');
}

function requirePermission(session, permissions) {
  requireSession(session);
  if (!permissions.includes(session.permission)) throw new AuthError(403, 'Permission denied');
}

function requireCsrf(request, session, config) {
  const origin = request.headers.origin;
  if (origin && origin !== new URL(config.publicBaseUrl).origin) throw new AuthError(403, 'Origin rejected');
  const supplied = request.headers['x-csrf-token'];
  if (typeof supplied !== 'string' || !safeEqual(supplied, session.csrfToken)) throw new AuthError(403, 'CSRF token rejected');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicSession(session) {
  return {
    account: {
      id: session.accountId,
      name: session.name,
      email: session.email,
    },
    permission: session.permission,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function commonHeaders() {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...commonHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function binary(response, statusCode, body, contentType, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...commonHeaders(),
    ...extraHeaders,
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'private, no-store',
  });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(302, { ...commonHeaders(), Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

function cookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').flatMap((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) return [];
    return [[entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1).trim())]];
  }));
}

function setCookie(response, name, value, options) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) parts.push('Secure');
  appendHeader(response, 'Set-Cookie', parts.join('; '));
}

function clearCookie(response, name, secure) {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  appendHeader(response, 'Set-Cookie', parts.join('; '));
}

function appendHeader(response, name, value) {
  const existing = response.getHeader(name);
  const values = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  response.setHeader(name, [...values, value]);
}

async function readRequest(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new AuthError(413, 'Payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function sendFile(response, filename, cacheControl = 'no-cache') {
  const info = await stat(filename);
  response.writeHead(200, {
    ...commonHeaders(),
    'Content-Type': MIME_TYPES.get(path.extname(filename).toLowerCase()) || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
  });
  createReadStream(filename).pipe(response);
}

function safeStaticPath(root, pathname) {
  const filename = path.resolve(root, pathname.replace(/^\/+/, ''));
  return filename === root || filename.startsWith(`${root}${path.sep}`) ? filename : null;
}

function cleanFilename(input) {
  return path.basename(input || 'game.gba').normalize('NFC')
    .replace(/[^\p{L}\p{N}._ ()-]/gu, '_').slice(0, 180);
}

function decodeFilenameHeader(input) {
  try { return decodeURIComponent(input || 'game.gba'); }
  catch { return input || 'game.gba'; }
}

function parseRom(buffer, filename, source) {
  const extension = path.extname(filename).toLowerCase();
  if (!['.gba', '.gb', '.gbc'].includes(extension)) {
    throw new AuthError(400, 'Only .gba, .gb and .gbc ROM files are supported');
  }
  if (buffer.length < 0x150) throw new AuthError(400, 'ROM header is too short');
  const isGba = extension === '.gba';
  const platform = isGba ? 'gba' : ((buffer[0x143] & 0x80) ? 'gbc' : 'gb');
  const title = (isGba ? buffer.subarray(0xa0, 0xac) : buffer.subarray(0x134, 0x143))
    .toString('ascii').replace(/\0+$/, '').trim();
  const gameCode = isGba ? buffer.subarray(0xac, 0xb0).toString('ascii') : platform.toUpperCase();
  if (!title || (isGba && !/^[ -~]{4}$/.test(gameCode))) throw new AuthError(400, 'Invalid ROM header');
  return {
    id: createHash('sha256').update(buffer).digest('hex'),
    platform,
    filename,
    title,
    gameCode,
    romIdentity: (isGba ? buffer.subarray(0xa0, 0xb0) : buffer.subarray(0x134, 0x143))
      .toString('ascii').replace(/\0+$/, ''),
    revision: buffer[isGba ? 0xbc : 0x14c],
    size: buffer.length,
    source,
    createdAt: Date.now(),
  };
}

async function syncRomCatalog(config, database) {
  for (const [directory, source] of [[config.fixtureDir, 'fixture'], [config.romStorageDir, 'uploaded']]) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !['.gba', '.gb', '.gbc'].includes(path.extname(entry.name).toLowerCase())) continue;
      const filename = path.join(directory, entry.name);
      const buffer = await readFile(filename);
      await database.upsertRom({ ...parseRom(buffer, entry.name, source), path: filename });
    }
  }
}

async function scanFixtures(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const fixtures = [];
  for (const entry of entries) {
    const extension = path.extname(entry.name).toLowerCase();
    if (!entry.isFile() || !['.sg1', '.sa1'].includes(extension)) continue;
    const filename = path.join(directory, entry.name);
    fixtures.push({
      id: createHash('sha256').update(entry.name).digest('hex').slice(0, 20),
      filename: entry.name,
      type: extension === '.sg1' ? 'state' : 'battery',
      size: (await stat(filename)).size,
      path: filename,
    });
  }
  return fixtures.sort((left, right) => left.filename.localeCompare(right.filename));
}

function validateState(payload, rom) {
  let raw;
  try { raw = gunzipSync(payload); }
  catch { throw new AuthError(400, 'State is not a valid gzip file'); }
  const isGba = rom.platform === 'gba';
  const expectedVersion = isGba ? 8 : 10;
  if ((isGba && raw.length !== 739838) || (!isGba && raw.length < 300)) {
    throw new AuthError(400, 'State payload size is invalid');
  }
  if (raw.readUInt32LE(0) !== expectedVersion) {
    throw new AuthError(400, `Only VBA state version ${expectedVersion} is supported for ${rom.platform}`);
  }
  const identity = raw.subarray(4, isGba ? 20 : 19).toString('ascii').replace(/\0+$/, '');
  if (identity !== rom.romIdentity) throw new AuthError(400, 'State ROM does not match selected ROM');
  if (isGba && raw.readUInt32LE(20) !== 0) throw new AuthError(400, 'BIOS states are not supported');
}

function validateBattery(payload) {
  if (![256, 512, 2048, 8192, 32768, 32812, 65536, 131072].includes(payload.length)) {
    throw new AuthError(400, 'Battery save size is invalid');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(`gbc-porting: ${app.config.publicBaseUrl}`);
  });
}
