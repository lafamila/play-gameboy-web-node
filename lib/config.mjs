import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function loadDotEnv(filename = path.join(process.cwd(), '.env')) {
  if (!existsSync(filename)) return;
  for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function integer(name, value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function createConfig(overrides = {}) {
  loadDotEnv();
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const root = overrides.root ?? process.cwd();
  const port = overrides.port ?? integer('PORT', process.env.PORT, 4173);
  const config = {
    nodeEnv,
    host: overrides.host ?? process.env.HOST ?? '127.0.0.1',
    port,
    publicBaseUrl: overrides.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    database: overrides.database ?? {
      driver: process.env.DB_DRIVER ?? 'mariadb',
      host: process.env.DB_HOST ?? 'localhost',
      port: integer('DB_PORT', process.env.DB_PORT, 33306),
      user: process.env.DB_USER ?? 'root',
      password: process.env.DB_PASSWORD ?? '',
      name: process.env.DB_NAME ?? 'gbc_porting',
    },
    romStorageDir: path.resolve(root, overrides.romStorageDir ?? process.env.ROM_STORAGE_DIR ?? 'roms'),
    fixtureDir: path.resolve(root, overrides.fixtureDir ?? process.env.FIXTURE_DIR ?? 'data'),
    authIssuerUrl: (overrides.authIssuerUrl ?? process.env.AUTH_ISSUER_URL ?? 'http://localhost:3032').replace(/\/$/, ''),
    authPublicBaseUrl: (overrides.authPublicBaseUrl ?? process.env.AUTH_PUBLIC_BASE_URL ?? process.env.AUTH_ISSUER_URL ?? 'http://localhost:3032').replace(/\/$/, ''),
    authApiBaseUrl: (overrides.authApiBaseUrl ?? process.env.AUTH_API_BASE_URL ?? process.env.AUTH_ISSUER_URL ?? 'http://localhost:3032').replace(/\/$/, ''),
    authJwksUrl: overrides.authJwksUrl ?? process.env.AUTH_JWKS_URL,
    authAudience: overrides.authAudience ?? process.env.AUTH_AUDIENCE ?? 'service:gbc-porting',
    authServiceKey: overrides.authServiceKey ?? process.env.AUTH_SERVICE_KEY ?? 'gbc-porting',
    oidcClientId: overrides.oidcClientId ?? process.env.GBC_PORTING_OIDC_CLIENT_ID ?? 'gbc-porting-web',
    oidcClientSecret: overrides.oidcClientSecret ?? process.env.GBC_PORTING_OIDC_CLIENT_SECRET,
    oidcRedirectUri: overrides.oidcRedirectUri ?? process.env.GBC_PORTING_OIDC_REDIRECT_URI ?? `http://localhost:${port}/auth/callback`,
    oidcTransactionTtlSeconds: overrides.oidcTransactionTtlSeconds ?? integer(
      'GBC_PORTING_OIDC_TRANSACTION_TTL_SECONDS',
      process.env.GBC_PORTING_OIDC_TRANSACTION_TTL_SECONDS,
      300,
    ),
    sessionCookieName: overrides.sessionCookieName ?? process.env.GBC_PORTING_SESSION_COOKIE_NAME ?? 'gbc_porting_session',
    sessionMaxAgeSeconds: overrides.sessionMaxAgeSeconds ?? integer(
      'GBC_PORTING_SESSION_MAX_AGE_SECONDS',
      process.env.GBC_PORTING_SESSION_MAX_AGE_SECONDS,
      60 * 60 * 24 * 7,
    ),
    sessionEncryptionKey: overrides.sessionEncryptionKey ?? process.env.GBC_PORTING_SESSION_ENCRYPTION_KEY,
    secureCookies: overrides.secureCookies ?? boolean(process.env.GBC_PORTING_SECURE_COOKIES, nodeEnv === 'production'),
    linkDebug: overrides.linkDebug ?? boolean(process.env.LINK_DEBUG, nodeEnv === 'development'),
    authTestMode: overrides.authTestMode ?? boolean(process.env.AUTH_TEST_MODE, false),
    maxRomBytes: overrides.maxRomBytes ?? 64 * 1024 * 1024,
    maxSaveBytes: overrides.maxSaveBytes ?? 2 * 1024 * 1024,
  };
  if (config.authTestMode && nodeEnv !== 'test') {
    throw new Error('AUTH_TEST_MODE is only allowed when NODE_ENV=test');
  }
  if (config.database.driver === 'memory' && nodeEnv !== 'test') {
    throw new Error('DB_DRIVER=memory is only allowed when NODE_ENV=test');
  }
  if (!config.sessionEncryptionKey) {
    throw new Error('GBC_PORTING_SESSION_ENCRYPTION_KEY is required');
  }
  if (!config.authTestMode && !config.oidcClientSecret) {
    throw new Error('GBC_PORTING_OIDC_CLIENT_SECRET is required');
  }
  return config;
}
