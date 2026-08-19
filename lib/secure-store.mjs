import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sessionHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export class SecretBox {
  constructor(secret) {
    this.key = createHash('sha256').update(secret).digest();
  }

  seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  open(value) {
    const payload = Buffer.from(value, 'base64url');
    if (payload.length < 29) throw new Error('Encrypted value is invalid');
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
  }
}

function decodeJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

export function verifyRs256Jwt(token, jwk, expectations) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT shape is invalid');
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (header.alg !== 'RS256' || header.kid !== jwk.kid) throw new Error('JWT signing key is invalid');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!valid) throw new Error('JWT signature is invalid');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('JWT is expired');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 5) throw new Error('JWT is not active');
  if (payload.iss !== expectations.issuer) throw new Error('JWT issuer is invalid');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expectations.audience)) throw new Error('JWT audience is invalid');
  return { header, payload };
}
