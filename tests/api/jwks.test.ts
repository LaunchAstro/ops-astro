// SPDX-License-Identifier: AGPL-3.0-only
//
// The key-set verifier (S0-6a), driven the way the sign-in adapter will drive
// it in S0-6b: a token in, one verdict out.
//
// No test here reaches a network. The provider is a substitute `fetch` that
// records every call and answers with a key set built from key pairs made in
// the test. Time is Vitest's fake clock, so the ten-minute cache and the
// thirty-second cooldown are measured, not waited for.
//
// The invariant test is `S0-6 refetch then refuse`: an unknown key triggers
// one refetch and then refusal, and a second unknown key inside the cooldown
// fetches nothing. It goes red if the cooldown is removed.

import type { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import {
  createKeySetVerifier,
  KEY_SET_CACHE_MS,
  KEY_SET_COOLDOWN_MS,
  KEY_SET_MAX_BYTES,
  KEY_SET_TIMEOUT_MS,
  type KeySetFetch,
  type KeySetRefusal,
  type KeySetVerifier,
} from '../../apps/api/auth/jwks.ts';

const KEY_SET_URL = 'https://auth.example.test/auth/v1/.well-known/jwks.json';
const ISSUER = 'https://auth.example.test/auth/v1';
const AUDIENCE = 'authenticated';
const START = new Date('2026-09-29T00:00:00Z');

interface KeyPair {
  readonly kid: string;
  readonly privateJwk: webcrypto.JsonWebKey & { alg: 'ES256'; kid: string };
  readonly publicJwk: webcrypto.JsonWebKey & { alg: 'ES256'; kid: string };
}

async function keyPair(kid: string): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateJwk: { ...priv, alg: 'ES256', kid },
    publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, alg: 'ES256', kid, use: 'sig' },
  } as KeyPair;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'b1d4c0de-0000-4000-8000-000000000001',
    aud: AUDIENCE,
    iss: ISSUER,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    ...overrides,
  };
}

async function tokenFor(pair: KeyPair, overrides: Record<string, unknown> = {}): Promise<string> {
  return await sign(claims(overrides), pair.privateJwk);
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A token with a hand-written header: the shapes `sign` will not produce. */
function handMade(header: Record<string, unknown>, signature = 'c2ln'): string {
  return `${b64url(header)}.${b64url(claims())}.${signature}`;
}

/** The substitute provider: what it serves can change between calls. */
function provider(initial: () => Response) {
  let answer = initial;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(answer());
  });
  return {
    fetch,
    calls,
    serve(next: () => Response) {
      answer = next;
    },
  };
}

/** The pinned address with a user name in it, built so no address sits in the source. */
function withCredentials(): string {
  const url = new URL(KEY_SET_URL);
  url.username = 'someone';
  return url.href;
}

function keySet(...pairs: KeyPair[]): () => Response {
  return () => Response.json({ keys: pairs.map((pair) => pair.publicJwk) });
}

function verifierOver(fetch: KeySetFetch, refusals: KeySetRefusal[] = []): KeySetVerifier {
  return createKeySetVerifier({
    keySetUrl: KEY_SET_URL,
    issuer: ISSUER,
    audience: AUDIENCE,
    fetch,
    onRefusal: (refusal) => refusals.push(refusal),
  });
}

let current: KeyPair;
let standby: KeyPair;
let stranger: KeyPair;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
  [current, standby, stranger] = await Promise.all([
    keyPair('current-1'),
    keyPair('standby-2'),
    keyPair('stranger-9'),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('S0-6 refetch then refuse', () => {
  it('fetches once for an unknown key after the cooldown, refuses, and a second unknown key inside the cooldown fetches nothing', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);

    expect((await verify(await tokenFor(current))).outcome).toBe('verified');
    expect(source.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(KEY_SET_COOLDOWN_MS + 1_000);
    expect(await verify(await tokenFor(stranger))).toEqual({
      outcome: 'refused',
      reason: 'unknown_key',
    });
    expect(source.fetch).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(5_000);
    const other = await keyPair('stranger-10');
    expect(await verify(await tokenFor(other))).toEqual({
      outcome: 'refused',
      reason: 'unknown_key',
    });
    expect(source.fetch).toHaveBeenCalledTimes(2);

    // The known key still verifies from the cache while the cooldown runs.
    expect((await verify(await tokenFor(current))).outcome).toBe('verified');
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses an unknown key inside the cooldown without fetching at all', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    await verify(await tokenFor(current));

    vi.advanceTimersByTime(KEY_SET_COOLDOWN_MS - 1_000);
    expect((await verify(await tokenFor(stranger))).outcome).toBe('refused');
    expect(source.fetch).toHaveBeenCalledTimes(1);
  });

  it('holds a burst of unknown keys to one fetch between them', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    await verify(await tokenFor(current));
    vi.advanceTimersByTime(KEY_SET_COOLDOWN_MS + 1);

    const tokens = await Promise.all(
      Array.from({ length: 20 }, async (_, index) => tokenFor(await keyPair(`burst-${index}`))),
    );
    const verdicts = await Promise.all(tokens.map((token) => verify(token)));
    expect(verdicts.every((verdict) => verdict.outcome === 'refused')).toBe(true);
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('S0-6 unknown key refused', () => {
  it('refuses a token signed by a key not in the set', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    expect(await verify(await tokenFor(stranger))).toEqual({
      outcome: 'refused',
      reason: 'unknown_key',
    });
  });

  it("refuses a token whose kid names a key in the set but whose signature is another key's", async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    const forged = await sign(claims(), { ...stranger.privateJwk, kid: current.kid });
    expect(await verify(forged)).toEqual({ outcome: 'refused', reason: 'signature' });
  });

  it('refuses a token with no kid, and never fetches for it', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    const { kid: _kid, ...keyWithoutKid } = current.privateJwk;
    const token = await sign(claims(), { ...keyWithoutKid, alg: 'ES256' } as webcrypto.JsonWebKey);
    expect(await verify(token)).toEqual({ outcome: 'refused', reason: 'header' });
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it('refuses a token for another audience or issuer, signed by a key in the set', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    expect((await verify(await tokenFor(current, { aud: 'service_role' }))).outcome).toBe(
      'refused',
    );
    expect(
      (await verify(await tokenFor(current, { iss: 'https://elsewhere.example.test' }))).outcome,
    ).toBe('refused');
  });

  it('refuses what is not a token at all', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    const junk = ['', 'a.b', 'a.b.c.d', 'not-base64!.x.y', `${b64url('text')}.x.y`];
    const verdicts = await Promise.all(junk.map((token) => verify(token)));
    expect(verdicts.map((verdict) => verdict.outcome)).toEqual(junk.map(() => 'refused'));
    expect(source.fetch).not.toHaveBeenCalled();
  });
});

describe('S0-6 algorithm refused', () => {
  it('refuses HS256 signed with the public key as its secret, and never fetches for it', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    // The classic confusion: the public key used as an HMAC secret.
    const confused = await sign(claims(), JSON.stringify(current.publicJwk), 'HS256');
    expect(await verify(confused)).toEqual({ outcome: 'refused', reason: 'algorithm' });
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it('refuses alg none, with and without a signature, and a token naming a key in the set', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    const tokens = [
      handMade({ alg: 'none', typ: 'JWT', kid: current.kid }, ''),
      handMade({ alg: 'none', typ: 'JWT' }, ''),
      handMade({ alg: 'NONE', typ: 'JWT', kid: current.kid }),
      handMade({ alg: 'HS256', typ: 'JWT', kid: current.kid }),
      handMade({ alg: 'RS256', typ: 'JWT', kid: current.kid }),
      handMade({ alg: 'ES384', typ: 'JWT', kid: current.kid }),
      handMade({ typ: 'JWT', kid: current.kid }),
    ];
    const verdicts = await Promise.all(tokens.map((token) => verify(token)));
    for (const verdict of verdicts) {
      expect(verdict).toEqual({ outcome: 'refused', reason: 'algorithm' });
    }
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it('never uses a published key whose own alg is not ES256', async () => {
    const source = provider(() =>
      Response.json({ keys: [{ ...current.publicJwk, alg: 'ES384' }] }),
    );
    const verify = verifierOver(source.fetch);
    expect(await verify(await tokenFor(current))).toEqual({
      outcome: 'refused',
      reason: 'unknown_key',
    });
  });

  it('never uses a published key with no alg of its own', async () => {
    const { alg: _alg, ...noAlg } = current.publicJwk;
    const source = provider(() => Response.json({ keys: [noAlg] }));
    const verify = verifierOver(source.fetch);
    expect((await verify(await tokenFor(current))).outcome).toBe('refused');
  });
});

describe('S0-6 rotated key accepted', () => {
  it('accepts a standby key promoted at the provider, inside the cache window, with no restart', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    expect((await verify(await tokenFor(current))).outcome).toBe('verified');

    // The provider promotes the standby key; the old one stays published.
    source.serve(keySet(standby, current));
    vi.advanceTimersByTime(KEY_SET_COOLDOWN_MS + 1);
    const promoted = await verify(await tokenFor(standby));
    expect(promoted.outcome).toBe('verified');
    expect(source.fetch).toHaveBeenCalledTimes(2);

    // Both keys now verify from the cache.
    expect((await verify(await tokenFor(current))).outcome).toBe('verified');
    expect((await verify(await tokenFor(standby))).outcome).toBe('verified');
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the key set at most ten minutes: a key the provider has withdrawn stops verifying', async () => {
    const source = provider(keySet(current, standby));
    const verify = verifierOver(source.fetch);
    expect((await verify(await tokenFor(current))).outcome).toBe('verified');

    source.serve(keySet(standby));
    vi.advanceTimersByTime(KEY_SET_CACHE_MS - 1_000);
    expect((await verify(await tokenFor(current, { iat: nowSeconds() }))).outcome).toBe('verified');
    expect(source.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect((await verify(await tokenFor(current))).outcome).toBe('refused');
    expect(source.fetch).toHaveBeenCalledTimes(2);
    expect(KEY_SET_CACHE_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('refuses everything once the cached set is older than ten minutes and the provider cannot answer', async () => {
    const refusals: KeySetRefusal[] = [];
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch, refusals);
    await verify(await tokenFor(current));

    source.serve(() => new Response('down', { status: 503 }));
    vi.advanceTimersByTime(KEY_SET_CACHE_MS + 1);
    expect(await verify(await tokenFor(current))).toEqual({
      outcome: 'refused',
      reason: 'key_set_unavailable',
    });
    expect(refusals).toEqual([{ reason: 'status' }]);
  });
});

describe('S0-6 expired genuine', () => {
  it('answers expired for a genuine ES256 token whose exp has passed', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    const token = await tokenFor(current, { iat: nowSeconds() - 7200, exp: nowSeconds() - 60 });
    expect(await verify(token)).toEqual({ outcome: 'expired' });
  });

  it('never answers expired for a forged token with a past exp', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    const forged = await sign(claims({ iat: nowSeconds() - 7200, exp: nowSeconds() - 60 }), {
      ...stranger.privateJwk,
      kid: current.kid,
    });
    expect(await verify(forged)).toEqual({ outcome: 'refused', reason: 'signature' });
  });

  it('never answers expired for a genuine past-exp token meant for another audience', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    const token = await tokenFor(current, { aud: 'service_role', exp: nowSeconds() - 60 });
    expect((await verify(token)).outcome).toBe('refused');
  });

  it('refuses a genuine token that carries no exp at all', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    const token = await tokenFor(current, { exp: undefined });
    expect(await verify(token)).toEqual({ outcome: 'refused', reason: 'claims' });
  });

  it('returns the verified claims for a live token', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    const verdict = await verify(await tokenFor(current));
    expect(verdict.outcome === 'verified' && verdict.claims['sub']).toBe(
      'b1d4c0de-0000-4000-8000-000000000001',
    );
  });
});

describe('S0-6 hostile provider', () => {
  it('Sol proof, criterion 6: malformed key rejects the whole provider set', async () => {
    const refusals: KeySetRefusal[] = [];
    const source = provider(() =>
      Response.json({
        keys: [current.publicJwk, { kid: 'broken', kty: 'EC', crv: 'P-256', alg: 'ES256' }],
      }),
    );
    const verify = verifierOver(source.fetch, refusals);

    expect(await verify(await tokenFor(current))).toEqual({
      outcome: 'refused',
      reason: 'key_set_unavailable',
    });
    expect(refusals).toEqual([{ reason: 'shape' }]);
  });

  it('fetches only the pinned address, follows no redirect, and sets a time limit', async () => {
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch);
    await verify(await tokenFor(current));
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]?.url).toBe(KEY_SET_URL);
    expect(source.calls[0]?.init?.redirect).toBe('error');
    expect(source.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(source.calls[0]?.init?.headers).toBeUndefined();
  });

  it('refuses at construction an address that is not a published key set, or not pinned to TLS', () => {
    const fetch = provider(keySet(current)).fetch;
    for (const keySetUrl of [
      'http://auth.example.test/auth/v1/.well-known/jwks.json',
      'https://auth.example.test/auth/v1/keys',
      withCredentials(),
      'https://auth.example.test/auth/v1/.well-known/jwks.json?kid=x',
      'not a url',
    ]) {
      expect(() =>
        createKeySetVerifier({ keySetUrl, issuer: ISSUER, audience: AUDIENCE, fetch }),
      ).toThrow(/key set address/u);
    }
    // The local auth server is plain HTTP on loopback only.
    expect(() =>
      createKeySetVerifier({
        keySetUrl: 'http://127.0.0.1:54391/.well-known/jwks.json',
        issuer: 'http://127.0.0.1:54391',
        audience: AUDIENCE,
        fetch,
      }),
    ).not.toThrow();
  });

  type Case = readonly [string, () => Response, KeySetRefusal['reason']];
  const hostile: Case[] = [
    [
      'a redirect',
      () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }),
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

  for (const [name, answer, reason] of hostile) {
    it(`refuses and records ${name}, and verifies nothing from it`, async () => {
      const refusals: KeySetRefusal[] = [];
      const source = provider(answer);
      const verify = verifierOver(source.fetch, refusals);
      expect(await verify(await tokenFor(current))).toEqual({
        outcome: 'refused',
        reason: 'key_set_unavailable',
      });
      expect(refusals).toEqual([{ reason }]);
    });
  }

  it('refuses a key set that publishes private key material, and records it', async () => {
    const refusals: KeySetRefusal[] = [];
    const source = provider(() => Response.json({ keys: [current.privateJwk] }));
    const verify = verifierOver(source.fetch, refusals);
    expect((await verify(await tokenFor(current))).outcome).toBe('refused');
    expect(refusals).toEqual([{ reason: 'private_key' }]);
  });

  it('refuses a key set that names one kid twice', async () => {
    const refusals: KeySetRefusal[] = [];
    const source = provider(() =>
      Response.json({ keys: [current.publicJwk, { ...stranger.publicJwk, kid: current.kid }] }),
    );
    const verify = verifierOver(source.fetch, refusals);
    expect((await verify(await tokenFor(current))).outcome).toBe('refused');
    expect(refusals).toEqual([{ reason: 'shape' }]);
  });

  it('refuses a key set with a point that is not on the curve', async () => {
    const refusals: KeySetRefusal[] = [];
    const bent = { ...current.publicJwk, y: current.publicJwk.x };
    const source = provider(() => Response.json({ keys: [bent] }));
    const verify = verifierOver(source.fetch, refusals);
    expect((await verify(await tokenFor(current))).outcome).toBe('refused');
    expect(refusals).toEqual([{ reason: 'shape' }]);
  });

  it('times out a provider that never answers, and records it', async () => {
    const refusals: KeySetRefusal[] = [];
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const verify = verifierOver(fetch, refusals);
    const pending = verify(await tokenFor(current));
    await vi.advanceTimersByTimeAsync(KEY_SET_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ outcome: 'refused', reason: 'key_set_unavailable' });
    expect(refusals).toEqual([{ reason: 'timeout' }]);
    expect(KEY_SET_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('keeps the good cached set when a refetch answers with something hostile', async () => {
    const refusals: KeySetRefusal[] = [];
    const source = provider(keySet(current));
    const verify = verifierOver(source.fetch, refusals);
    await verify(await tokenFor(current));

    source.serve(() => Response.json({ keys: [stranger.publicJwk, stranger.privateJwk] }));
    vi.advanceTimersByTime(KEY_SET_COOLDOWN_MS + 1);
    expect((await verify(await tokenFor(stranger))).outcome).toBe('refused');
    expect((await verify(await tokenFor(current))).outcome).toBe('verified');
    expect(refusals).toEqual([{ reason: 'private_key' }]);
  });

  it('records reasons only: no key material, body text or address reaches a refusal', async () => {
    const refusals: KeySetRefusal[] = [];
    const source = provider(() => Response.json({ keys: [current.privateJwk] }));
    const verify = verifierOver(source.fetch, refusals);
    await verify(await tokenFor(current));
    const written = JSON.stringify(refusals);
    expect(written).not.toContain(String(current.privateJwk.d));
    expect(written).not.toContain(String(current.privateJwk.x));
    expect(written).not.toContain('example.test');
    expect(Object.keys(refusals[0] ?? {})).toEqual(['reason']);
  });
});
