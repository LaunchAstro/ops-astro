// SPDX-License-Identifier: AGPL-3.0-only
//
// The local auth server's ES256 signing key, and the one token the local seed
// tools sign with it (S0-6b, LF-4).
//
// Run as a script, it prints a new key as GoTrue's `GOTRUE_JWT_KEYS` takes it.
// `auth-up.sh` keeps it in `.local/auth-signing-key.json`, which the API never
// reads: it fetches the public half from GoTrue. An unusable key is refused by
// what is wrong with it, never by its content, which is private key material.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CURVE = { name: 'ECDSA', namedCurve: 'P-256' };
const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** One new ES256 key, private members included, as `GOTRUE_JWT_KEYS` wants it. */
export async function generateSigningKeys() {
  const { privateKey } = await crypto.subtle.generateKey(CURVE, true, ['sign', 'verify']);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', privateKey);
  const kid = `local-${crypto.randomUUID()}`;
  return [{ kty, crv, x, y, d, kid, alg: 'ES256', use: 'sig', key_ops: ['sign', 'verify'] }];
}

/**
 * The admin API's bearer: `service_role`, five minutes, signed ES256 with the
 * local key. It replaces the HS256 token the seed tools made with the shared
 * secret, and never leaves the process that asked for it.
 */
export async function serviceToken(keys) {
  const [key, ...others] = Array.isArray(keys) ? keys : [];
  // The curve and the private member are checked by the import below.
  if (others.length > 0 || key?.alg !== 'ES256' || typeof key.kid !== 'string') {
    throw new Error('signing-key: the local key is not one ES256 private key; run auth-up.sh');
  }
  const { kty, crv, x, y, d } = key;
  const privateKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, CURVE, false, [
    'sign',
  ]);
  const now = Math.floor(Date.now() / 1000);
  const header = part({ alg: 'ES256', typ: 'JWT', kid: key.kid });
  const payload = part({
    role: 'service_role',
    aud: 'authenticated',
    iss: 'ops-astro-local-seed',
    iat: now,
    exp: now + 300,
  });
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    Buffer.from(`${header}.${payload}`),
  );
  return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
}

/** The checkout's own key, or undefined when `auth-up.sh` has not run. */
export async function localServiceToken(root) {
  const file = join(root, '.local', 'auth-signing-key.json');
  if (!existsSync(file)) return;
  let keys;
  try {
    keys = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('signing-key: .local/auth-signing-key.json is not JSON; run auth-up.sh');
  }
  return await serviceToken(keys);
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await generateSigningKeys())}\n`);
}
