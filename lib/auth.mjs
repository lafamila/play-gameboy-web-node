import { createHash } from 'node:crypto';

import {
  SecretBox,
  pkceChallenge,
  randomToken,
  sessionHash,
  verifyRs256Jwt,
} from './secure-store.mjs';

const SERVICE_CLAIM = 'https://lafamila.xyz/claims/service';
const ALLOWED_PERMISSIONS = new Set(['visitor', 'user', 'admin', 'superadmin']);

export class AuthClient {
  constructor(config, database) {
    this.config = config;
    this.database = database;
    this.secrets = new SecretBox(config.sessionEncryptionKey);
    this.jwks = new Map();
    this.jwksFetchedAt = 0;
    this.refreshes = new Map();
  }

  async startLogin(returnTo = '/', promptLogin = false) {
    const normalizedReturnTo = normalizeReturnTo(returnTo);
    const state = randomToken(32);
    const verifier = randomToken(48);
    await this.database.putTransaction({
      state,
      verifierCipher: this.secrets.seal(verifier),
      returnTo: normalizedReturnTo,
      expiresAt: Date.now() + this.config.oidcTransactionTtlSeconds * 1000,
    });
    const authorizeUrl = new URL('/oauth/authorize', this.config.authPublicBaseUrl);
    authorizeUrl.searchParams.set('client_id', this.config.oidcClientId);
    authorizeUrl.searchParams.set('redirect_uri', this.config.oidcRedirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'openid profile email service.permission');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    if (promptLogin) authorizeUrl.searchParams.set('prompt', 'login');
    return { authorizeUrl: authorizeUrl.toString(), state };
  }

  async completeLogin({ code, state, stateCookie }) {
    if (!code || !state || !stateCookie || state !== stateCookie) {
      throw new AuthError(400, 'Invalid OIDC callback state');
    }
    const transaction = await this.database.consumeTransaction(state);
    if (!transaction) throw new AuthError(400, 'OIDC login transaction expired');
    const token = await this.requestToken({
      grant_type: 'authorization_code',
      client_id: this.config.oidcClientId,
      client_secret: this.config.oidcClientSecret,
      redirect_uri: this.config.oidcRedirectUri,
      code,
      code_verifier: this.secrets.open(transaction.verifier_cipher),
    });
    return {
      ...(await this.createSession(token)),
      returnTo: normalizeReturnTo(transaction.return_to),
    };
  }

  async createTestSession(input) {
    if (!this.config.authTestMode) throw new AuthError(404, 'Not found');
    const permission = ALLOWED_PERMISSIONS.has(input.permission) ? input.permission : 'visitor';
    const now = Date.now();
    const rawSessionId = randomToken(32);
    const csrfToken = randomToken(24);
    await this.database.putSession({
      sessionHash: sessionHash(rawSessionId),
      accountId: input.accountId,
      subject: input.accountId,
      displayName: input.name ?? input.accountId,
      email: input.email ?? `${input.accountId}@example.invalid`,
      permission,
      accessTokenCipher: this.secrets.seal(`test-access-${input.accountId}`),
      refreshTokenCipher: this.secrets.seal(`test-refresh-${input.accountId}`),
      accessExpiresAt: now + this.config.sessionMaxAgeSeconds * 1000,
      csrfToken,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.config.sessionMaxAgeSeconds * 1000,
    });
    return { rawSessionId, session: await this.getSession(rawSessionId), csrfToken };
  }

  async createSession(token) {
    if (!token.access_token || !token.refresh_token || !token.expires_in) {
      throw new AuthError(401, 'Auth token response is incomplete');
    }
    const account = await this.verifyAccessToken(token.access_token);
    const now = Date.now();
    const rawSessionId = randomToken(32);
    const csrfToken = randomToken(24);
    await this.database.putSession({
      sessionHash: sessionHash(rawSessionId),
      accountId: account.accountId,
      subject: account.subject,
      displayName: account.name,
      email: account.email,
      permission: account.permission,
      accessTokenCipher: this.secrets.seal(token.access_token),
      refreshTokenCipher: this.secrets.seal(token.refresh_token),
      accessExpiresAt: now + Number(token.expires_in) * 1000,
      csrfToken,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.config.sessionMaxAgeSeconds * 1000,
    });
    return { rawSessionId, session: await this.getSession(rawSessionId), csrfToken };
  }

  async getSession(rawSessionId) {
    if (!rawSessionId) return null;
    const hash = sessionHash(rawSessionId);
    let row = await this.database.getSession(hash);
    if (!row) return null;
    const now = Date.now();
    if (Number(row.expires_at) <= now) {
      await this.database.deleteSession(hash);
      return null;
    }
    if (!this.config.authTestMode && Number(row.access_expires_at) - now <= 60_000) {
      row = await this.refreshSession(hash, row);
    }
    await this.database.touchSession(hash, now);
    return this.rowToSession(row, rawSessionId);
  }

  async refreshSession(hash, row) {
    if (this.refreshes.has(hash)) return this.refreshes.get(hash);
    const pending = (async () => {
      try {
        const token = await this.requestToken({
          grant_type: 'refresh_token',
          client_id: this.config.oidcClientId,
          client_secret: this.config.oidcClientSecret,
          refresh_token: this.secrets.open(row.refresh_token_cipher),
        });
        if (!token.access_token || !token.refresh_token || !token.expires_in) {
          throw new AuthError(401, 'Auth refresh response is incomplete');
        }
        const account = await this.verifyAccessToken(token.access_token);
        const now = Date.now();
        await this.database.putSession({
          sessionHash: hash,
          accountId: account.accountId,
          subject: account.subject,
          displayName: account.name,
          email: account.email,
          permission: account.permission,
          accessTokenCipher: this.secrets.seal(token.access_token),
          refreshTokenCipher: this.secrets.seal(token.refresh_token),
          accessExpiresAt: now + Number(token.expires_in) * 1000,
          csrfToken: row.csrf_token,
          createdAt: Number(row.created_at),
          lastSeenAt: now,
          expiresAt: Number(row.expires_at),
        });
        return await this.database.getSession(hash);
      } catch (error) {
        await this.database.deleteSession(hash);
        throw error;
      } finally {
        this.refreshes.delete(hash);
      }
    })();
    this.refreshes.set(hash, pending);
    return pending;
  }

  async logout(rawSessionId) {
    if (!rawSessionId) return;
    const hash = sessionHash(rawSessionId);
    const row = await this.database.getSession(hash);
    await this.database.deleteSession(hash);
    if (row && !this.config.authTestMode) {
      try {
        const token = this.secrets.open(row.refresh_token_cipher);
        await fetch(`${this.config.authApiBaseUrl}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
      } catch {
        // The local session is already gone; remote revocation is best effort.
      }
    }
  }

  async requestAccess(session) {
    if (session.permission !== 'visitor') throw new AuthError(403, 'Only visitors can request access');
    if (!this.config.authTestMode) {
      const response = await fetch(`${this.config.authApiBaseUrl}/api/service-applications`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          serviceKey: this.config.authServiceKey,
          requestedPermissionKey: 'user',
          message: 'Play Game Boy의 기본 사용자 권한을 요청합니다.',
        }),
      });
      if (!response.ok) throw new AuthError(response.status, await responseMessage(response, 'Access request failed'));
    }
    await this.database.recordAccessRequest(session.accountId);
    return this.database.getAccessRequest(session.accountId);
  }

  rowToSession(row, rawSessionId) {
    return {
      rawSessionId,
      accountId: row.account_id,
      subject: row.subject,
      name: row.display_name,
      email: row.email,
      permission: row.permission,
      csrfToken: row.csrf_token,
      accessToken: this.secrets.open(row.access_token_cipher),
      expiresAt: Number(row.expires_at),
    };
  }

  async requestToken(body) {
    const response = await fetch(`${this.config.authApiBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new AuthError(response.status, await responseMessage(response, 'Token exchange failed'));
    return response.json();
  }

  async verifyAccessToken(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError(401, 'Access token is invalid');
    let header;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
    catch { throw new AuthError(401, 'Access token header is invalid'); }
    let jwk = await this.getJwk(header.kid, false);
    if (!jwk) jwk = await this.getJwk(header.kid, true);
    if (!jwk) throw new AuthError(401, 'Access token signing key is unknown');
    let payload;
    try {
      payload = verifyRs256Jwt(token, jwk, {
        issuer: this.config.authIssuerUrl,
        audience: this.config.authAudience,
      }).payload;
    } catch (error) {
      throw new AuthError(401, error.message);
    }
    const service = payload[SERVICE_CLAIM];
    if (!service || service.key !== this.config.authServiceKey) throw new AuthError(401, 'Service claim is invalid');
    if (!ALLOWED_PERMISSIONS.has(service.permission)) throw new AuthError(403, 'Service permission is invalid');
    if (typeof payload.sub !== 'string' || !payload.sub) throw new AuthError(401, 'Access token subject is missing');
    return {
      accountId: payload.sub,
      subject: payload.sub,
      name: typeof payload.name === 'string' ? payload.name : null,
      email: typeof payload.email === 'string' ? payload.email : null,
      permission: service.permission,
    };
  }

  async getJwk(kid, force) {
    if (!force && Date.now() - this.jwksFetchedAt < 300_000 && this.jwks.has(kid)) return this.jwks.get(kid);
    const response = await fetch(this.config.authJwksUrl ?? `${this.config.authApiBaseUrl}/oauth/jwks`);
    if (!response.ok) throw new AuthError(503, 'Unable to fetch auth JWKS');
    const body = await response.json();
    this.jwks.clear();
    for (const key of body.keys ?? []) if (key.kid) this.jwks.set(key.kid, key);
    this.jwksFetchedAt = Date.now();
    return this.jwks.get(kid);
  }
}

export class AuthError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function normalizeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

async function responseMessage(response, fallback) {
  try {
    const body = await response.json();
    return body.detail ?? body.message ?? body.error_description ?? fallback;
  } catch {
    return fallback;
  }
}
