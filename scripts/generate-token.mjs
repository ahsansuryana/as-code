#!/usr/bin/env node
// Generates a new random bearer secret + its scrypt hash.
//
// The raw token is shown ONCE here and never written to disk by this
// script — save it in a password manager. Only the hash goes in .env,
// so a leaked .env no longer hands out a working credential on its own.

import crypto from 'crypto';

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

function hashToken(rawToken) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(rawToken, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

const token = crypto.randomBytes(32).toString('hex');
const stored = hashToken(token);

console.log('');
console.log('🔑 New bearer token generated.');
console.log('');
console.log('Save this raw token somewhere safe (password manager, secrets vault).');
console.log('It will NOT be shown again and is NOT written to any file:');
console.log('');
console.log('  ' + token);
console.log('');
console.log('Add ONLY the hash below to your .env (replace any existing BEARER_TOKEN_HASH line):');
console.log('');
console.log('  BEARER_TOKEN_HASH=' + stored);
console.log('');
console.log('If your .env still has a plaintext "BEARER_TOKEN=..." line, delete it —');
console.log('BEARER_TOKEN_HASH alone is sufficient once this is in place.');
console.log('');
console.log('Use the raw token above wherever a "server password" or Bearer token is');
console.log('requested (OAuth consent page, direct Authorization: Bearer header).');
console.log('');
