import crypto from 'crypto';

/**
 * Secret-token hashing & verification.
 *
 * The server previously compared incoming Bearer tokens directly against a
 * plaintext BEARER_TOKEN value loaded from .env. That means anyone who reads
 * .env (a leaked backup, a misconfigured volume mount, a `cat .env` typo in
 * a shared terminal, etc.) obtains a credential that works immediately,
 * against both the OAuth consent password field and the raw Bearer header
 * fallback.
 *
 * Instead, the server now stores only a salted scrypt hash of the secret
 * (BEARER_TOKEN_HASH). The raw token is generated once (see
 * scripts/generate-token.mjs), shown to the operator exactly once, and never
 * written to disk. Every login attempt re-hashes the *supplied* value with
 * the stored salt and compares digests in constant time — the stored value
 * on its own cannot be replayed as a credential.
 */

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** Hash a raw secret token. Stored format: `scrypt$<saltHex>$<hashHex>`. */
export function hashToken(rawToken: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(rawToken, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a raw candidate token against a stored value in constant time.
 *
 * Accepts the `scrypt$...` format produced by hashToken(). Also accepts a
 * bare legacy plaintext secret (no `scrypt$` prefix) so existing
 * deployments keep working during migration — this path still uses a
 * constant-time comparison, but should be migrated off via
 * `npm run generate-token` as soon as possible, since the plaintext value
 * sitting in .env is exactly the risk this module exists to remove.
 */
export function verifyTokenHash(rawToken: string | undefined | null, stored: string | undefined | null): boolean {
  if (!rawToken || !stored) return false;

  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const [, saltHex, hashHex] = parts;
    try {
      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(hashHex, 'hex');
      if (salt.length === 0 || expected.length === 0) return false;
      const actual = crypto.scryptSync(rawToken, salt, expected.length);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  // Legacy plaintext fallback (deprecated). Still constant-time.
  const a = Buffer.from(rawToken);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
