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
import { KEY_SET_COOLDOWN_MS } from '../../apps/api/auth/jwks.ts';
import {
  START,
  type KeyPair,
  keyPair,
  claims,
  tokenFor,
  b64url,
  handMade,
  keySet,
  verifierOver,
  provider,
} from './jwks.fixture.ts';

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

describe('S0-6 refetch then refuse', () => {
  refetchThenRefuseCases1();
  refetchThenRefuseCases2();
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

function refetchThenRefuseCases1() {
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
}

function refetchThenRefuseCases2() {
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
}
