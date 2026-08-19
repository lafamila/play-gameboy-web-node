import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';

import { AuthClient } from '../lib/auth.mjs';
import { MemoryDatabase } from '../lib/database.mjs';

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `test-${randomUUID()}`;
  return {
    privateKey,
    publicJwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
}

function jwt(privateKey, kid, payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

test('OIDC access-token verification accepts only this service and its four permissions', async () => {
  const key = makeKey();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [key.publicJwk] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const config = {
    sessionEncryptionKey: 'jwt-test-session-key',
    authTestMode: false,
    authIssuerUrl: 'https://auth.example.test',
    authAudience: 'service:gbc-porting',
    authServiceKey: 'gbc-porting',
    authApiBaseUrl: 'https://auth.example.test',
    authJwksUrl: 'https://auth.example.test/oauth/jwks',
  };
  const auth = new AuthClient(config, new MemoryDatabase());
  const now = Math.floor(Date.now() / 1000);
  const makeToken = (permission, overrides = {}) => jwt(key.privateKey, key.publicJwk.kid, {
    iss: config.authIssuerUrl,
    sub: 'account-1',
    aud: config.authAudience,
    exp: now + 300,
    name: 'Account One',
    email: 'account@example.test',
    'https://lafamila.xyz/claims/service': { key: 'gbc-porting', permission, permissionSchemaVersion: 1 },
    ...overrides,
  });
  try {
    for (const permission of ['visitor', 'user', 'admin', 'superadmin']) {
      const account = await auth.verifyAccessToken(makeToken(permission));
      assert.equal(account.permission, permission);
      assert.equal(account.accountId, 'account-1');
    }
    await assert.rejects(() => auth.verifyAccessToken(makeToken('owner')), /permission/i);
    await assert.rejects(
      () => auth.verifyAccessToken(makeToken('user', { aud: 'service:other' })),
      /audience/i,
    );
    await assert.rejects(
      () => auth.verifyAccessToken(makeToken('user', {
        'https://lafamila.xyz/claims/service': { key: 'other', permission: 'user' },
      })),
      /service claim/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('visitor access requests explicitly target the user permission', async () => {
  const database = new MemoryDatabase();
  const auth = new AuthClient({
    authTestMode: false,
    authApiBaseUrl: 'https://auth.example.test',
    authServiceKey: 'gbc-porting',
    sessionEncryptionKey: 'access-request-test-key',
  }, database);
  const originalFetch = globalThis.fetch;
  let submitted;
  globalThis.fetch = async (_url, options) => {
    submitted = JSON.parse(options.body);
    return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await auth.requestAccess({
      accountId: 'visitor-account', permission: 'visitor', accessToken: 'visitor-token',
    });
    assert.equal(result.status, 'pending');
    assert.equal(submitted.serviceKey, 'gbc-porting');
    assert.equal(submitted.requestedPermissionKey, 'user');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
