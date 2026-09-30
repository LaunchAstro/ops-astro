// SPDX-License-Identifier: AGPL-3.0-only
//
// The key-set verifier (S0-6a), continued: `S0-6 hostile provider`, each
// hostile answer refused and recorded by its reason, verifying nothing from it.
// The helpers are jwks.fixture.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createKeySetVerifier,
  KEY_SET_COOLDOWN_MS,
  KEY_SET_TIMEOUT_MS,
  type KeySetRefusal,
} from '../../apps/api/auth/jwks.ts';
import {
  KEY_SET_URL,
  ISSUER,
  AUDIENCE,
  START,
  type KeyPair,
  keyPair,
  tokenFor,
  withCredentials,
  keySet,
  verifierOver,
  hostile,
} from './jwks.fixture.ts';

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

let current: KeyPair;

let stranger: KeyPair;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
  [current, , stranger] = await Promise.all([
    keyPair('current-1'),
    keyPair('standby-2'),
    keyPair('stranger-9'),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('S0-6 hostile provider', () => {
  hostileProviderCases1();
  hostileProviderCases2();
  hostileProviderCases3();
  hostileProviderCases4();
});

function hostileProviderCases1() {
  it('malformed key rejects the whole provider set', async () => {
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
}

function hostileProviderCases2() {
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

  hostile.forEach(([name, answer, reason]) => {
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
  });

  it('refuses a key set that publishes private key material, and records it', async () => {
    const refusals: KeySetRefusal[] = [];
    const source = provider(() => Response.json({ keys: [current.privateJwk] }));
    const verify = verifierOver(source.fetch, refusals);
    expect((await verify(await tokenFor(current))).outcome).toBe('refused');
    expect(refusals).toEqual([{ reason: 'private_key' }]);
  });
}

function hostileProviderCases3() {
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
}

function hostileProviderCases4() {
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
}
