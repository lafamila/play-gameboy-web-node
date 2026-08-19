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

test('OIDC access-token verification accepts only this service and its three permissions', async () => {
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
    for (const permission of ['visitor', 'user', 'superadmin']) {
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
