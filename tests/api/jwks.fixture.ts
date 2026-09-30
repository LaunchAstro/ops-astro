// SPDX-License-Identifier: AGPL-3.0-only
//
// The key-set verifier suites' shared helpers (jwks*.test.ts): key pairs, claims
// and tokens, hand-made headers, and a substitute provider that records every
// call and answers from a key set built in the test.

import { randomBytes, type webcrypto } from 'node:crypto';
import { sign } from 'hono/jwt';
import {
  createKeySetVerifier,
  KEY_SET_MAX_BYTES,
  type KeySetFetch,
  type KeySetRefusal,
  type KeySetVerifier,
} from '../../apps/api/auth/jwks.ts';
import { TEST_ONLY_MARKER } from '../support/marker.ts';

/** Made at run time from the one marker (option A), as tests/support/sign-in.ts does. */
const made = (name = ''): string => `${TEST_ONLY_MARKER}-${name}${randomBytes(6).toString('hex')}`;

export const ISSUER: string = `https://${made()}.example.test/auth/v1`;

export const KEY_SET_URL: string = `${ISSUER}/.well-known/jwks.json`;

export const AUDIENCE = 'authenticated';

export const START: Date = new Date('2026-09-29T00:00:00Z');

export interface KeyPair {
  readonly kid: string;
  readonly privateJwk: webcrypto.JsonWebKey & { alg: 'ES256'; kid: string };
  readonly publicJwk: webcrypto.JsonWebKey & { alg: 'ES256'; kid: string };
}

export async function keyPair(name: string): Promise<KeyPair> {
  const kid = made(`${name}-`);
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateJwk: { ...priv, alg: 'ES256', kid },
    publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, alg: 'ES256', kid, use: 'sig' },
  } as KeyPair;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'b1d4c0de-0000-4000-8000-000000000001',
    aud: AUDIENCE,
    iss: ISSUER,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    ...overrides,
  };
}

export async function tokenFor(
  pair: KeyPair,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return await sign(claims(overrides), pair.privateJwk);
}

export function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A token with a hand-written header: the shapes `sign` will not produce. */
export function handMade(header: Record<string, unknown>, signature = 'c2ln'): string {
  return `${b64url(header)}.${b64url(claims())}.${signature}`;
}

/** The pinned address with a user name in it, built so no address sits in the source. */
export function withCredentials(): string {
  const url = new URL(KEY_SET_URL);
  url.username = 'someone';
  return url.href;
}

export function keySet(...pairs: KeyPair[]): () => Response {
  return () => Response.json({ keys: pairs.map((pair) => pair.publicJwk) });
}

export function verifierOver(fetch: KeySetFetch, refusals: KeySetRefusal[] = []): KeySetVerifier {
  return createKeySetVerifier({
    keySetUrl: KEY_SET_URL,
    issuer: ISSUER,
    audience: AUDIENCE,
    fetch,
    onRefusal: (refusal) => refusals.push(refusal),
  });
}

export type Case = readonly [string, () => Response, KeySetRefusal['reason']];

export const hostile: Case[] = [
  [
    'a redirect',
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }),
    'status',
  ],
  ['a server error', () => new Response('no', { status: 500 }), 'status'],
  ['a body that is not JSON', () => new Response('<html>'), 'shape'],
  ['a body with no keys', () => Response.json({ items: [] }), 'shape'],
  ['keys that are not a list', () => Response.json({ keys: {} }), 'shape'],
  ['an empty key list', () => Response.json({ keys: [] }), 'shape'],
  [
    'a declared length over the cap',
    () => new Response('{}', { headers: { 'content-length': String(KEY_SET_MAX_BYTES + 1) } }),
    'too_large',
  ],
  [
    'a body over the cap with no declared length',
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const chunk = new TextEncoder().encode(' '.repeat(16 * 1024));
            for (let sent = 0; sent <= KEY_SET_MAX_BYTES; sent += chunk.length) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
      ),
    'too_large',
  ],
];
