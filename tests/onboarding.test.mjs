import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('service onboarding matches the runtime OIDC and managed-permission contract', async () => {
  const onboarding = JSON.parse(await readFile(path.join(root, 'auth', 'service-onboarding.json'), 'utf8'));
  assert.equal(onboarding.serviceKey, 'gbc-porting');
  assert.deepEqual(onboarding.permissions.map((permission) => permission.key), ['user', 'admin']);
  assert.ok(!onboarding.permissions.some((permission) => ['visitor', 'superadmin'].includes(permission.key)));
  assert.deepEqual(onboarding.oidcClients, [{
    clientId: 'gbc-porting-web',
    clientType: 'confidential',
    redirectUris: [
      'http://localhost:4173/auth/callback',
      'https://play.lafamila.xyz/auth/callback',
    ],
    allowedScopes: ['openid', 'profile', 'email', 'service.permission'],
    requirePkce: true,
  }]);
  assert.deepEqual(onboarding.serviceCredentials, []);
});

test('permission-only onboarding update adds admin without rotating the OIDC client', async () => {
  const update = JSON.parse(await readFile(path.join(root, 'auth', 'permission-update.json'), 'utf8'));
  assert.equal(update.serviceKey, 'gbc-porting');
  assert.deepEqual(update.permissions.map((permission) => permission.key), ['user', 'admin']);
  assert.equal(Object.hasOwn(update, 'oidcClients'), false);
  assert.equal(Object.hasOwn(update, 'serviceCredentials'), false);
});

test('.env.example contains the MariaDB, OIDC and session secret inputs', async () => {
  const example = await readFile(path.join(root, '.env.example'), 'utf8');
  for (const key of [
    'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
    'AUTH_ISSUER_URL', 'AUTH_PUBLIC_BASE_URL', 'AUTH_API_BASE_URL', 'AUTH_JWKS_URL',
    'AUTH_AUDIENCE', 'AUTH_SERVICE_KEY', 'GBC_PORTING_OIDC_CLIENT_ID',
    'GBC_PORTING_OIDC_CLIENT_SECRET', 'GBC_PORTING_OIDC_REDIRECT_URI',
    'GBC_PORTING_SESSION_ENCRYPTION_KEY',
  ]) assert.match(example, new RegExp(`^${key}=`, 'm'), key);
});
