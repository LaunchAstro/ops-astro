// SPDX-License-Identifier: AGPL-3.0-only
//
// The key-set verifier's shape check (see jwks.ts): a fetched body in, the
// usable ES256 keys or the reason the answer is refused out. A set that
// carries private key material is refused outright, and an entry that names
// ES256 is whole or the whole answer is refused.

import type { webcrypto } from 'node:crypto';

const MAX_KEYS = 32;
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];
const COORDINATE = /^[\w-]{43}$/u;

// The key type `crypto.subtle` itself returns, so the same line typechecks
// under Node's declarations and under the DOM's (the web program imports this
// file through the sign-in adapter).
export type ImportedKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
export type KeySet = ReadonlyMap<string, ImportedKey>;

/** The shape check: `{ keys: [...] }`, public members only, one entry per `kid`. */
export async function parseKeySet(body: Uint8Array): Promise<KeySet | 'shape' | 'private_key'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return 'shape';
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) return 'shape';
  if (!keys.every((key) => typeof key === 'object' && key !== null && !Array.isArray(key))) {
    return 'shape';
  }
  const entries = keys as Record<string, unknown>[];
  if (entries.some((key) => PRIVATE_MEMBERS.some((member) => member in key))) return 'private_key';
  const kids = entries.map((key) => key['kid']).filter((kid) => typeof kid === 'string');
  if (new Set(kids).size !== kids.length) return 'shape';

  // An entry that names ES256 is one this verifier would use, so it is whole
  // or the answer is refused; it is never quietly skipped beside a good key.
  // Entries naming another algorithm are left alone.
  const claimed = entries.filter((key) => key['alg'] === 'ES256');
  if (!claimed.every((key) => isUsable(key))) return 'shape';

  const usable = new Map<string, ImportedKey>();
  const imports = claimed.map(async (key) => {
    const imported = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: key['x'], y: key['y'] } as webcrypto.JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    usable.set(key['kid'] as string, imported);
  });
  try {
    await Promise.all(imports);
  } catch {
    // A coordinate pair that is not a point on the curve.
    return 'shape';
  }
  return usable;
}

/** A complete ES256 public key: the only shape an ES256 entry may have. */
function isUsable(key: Record<string, unknown>): boolean {
  const ops = key['key_ops'];
  return (
    key['kty'] === 'EC' &&
    key['crv'] === 'P-256' &&
    key['alg'] === 'ES256' &&
    typeof key['kid'] === 'string' &&
    key['kid'] !== '' &&
    typeof key['x'] === 'string' &&
    COORDINATE.test(key['x']) &&
    typeof key['y'] === 'string' &&
    COORDINATE.test(key['y']) &&
    (key['use'] === undefined || key['use'] === 'sig') &&
    (ops === undefined || (Array.isArray(ops) && ops.includes('verify')))
  );
}
