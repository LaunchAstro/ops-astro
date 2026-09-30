// SPDX-License-Identifier: AGPL-3.0-only
//
// The key-set verifier (S0-6a), continued: `S0-6 rotated key accepted` and
// `S0-6 expired genuine`. The helpers are jwks.fixture.ts; the invariant
// `S0-6 refetch then refuse` and the refusals are in jwks.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import {
  KEY_SET_CACHE_MS,
  KEY_SET_COOLDOWN_MS,
  type KeySetRefusal,
} from '../../apps/api/auth/jwks.ts';
import {
  START,
  type KeyPair,
  keyPair,
  nowSeconds,
  claims,
  tokenFor,
  keySet,
  verifierOver,
  provider,
} from './jwks.fixture.ts';

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
