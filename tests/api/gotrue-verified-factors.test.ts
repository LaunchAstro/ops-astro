// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: the provider's list of a login's verified factors, read off GoTrue's
// user (`GET /user`) with the person's own token. Only verified factors'
// ids are kept, and an answer not shaped as GoTrue's is refused whole. No
// request leaves the test process.
import { expect, it } from 'vitest';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';

const BASE = 'http://identity.invalid/auth/v1';

function answering(status: number, body: unknown) {
  const seen: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push(`${init?.method} ${String(input)} ${headers.get('authorization')}`);
    return Promise.resolve(Response.json(body, { status }));
  };
  return { seen, provider: createGoTrueFactors({ baseUrl: BASE, fetch }) };
}

it("C59: the provider lists only the login's verified factors, asked with its own token", async () => {
  const { seen, provider } = answering(200, {
    id: 'user-one',
    factors: [
      { id: 'factor-new', factor_type: 'totp', status: 'unverified' },
      { id: 'factor-one', factor_type: 'totp', status: 'verified' },
    ],
  });
  expect(await provider.verifiedFactors('person-token')).toEqual({
    ok: true,
    value: ['factor-one'],
  });
  expect(seen).toEqual([`GET ${BASE}/user Bearer person-token`]);
});

it('C59: a user with no factors, which GoTrue answers without the field, lists none', async () => {
  const { provider } = answering(200, { id: 'user-one' });
  expect(await provider.verifiedFactors('person-token')).toEqual({ ok: true, value: [] });
});

it('C59: a factor list not shaped as GoTrue answers it is refused whole', async () => {
  for (const factors of [
    'factor-one',
    [{ id: '../admin', status: 'verified' }],
    [{ id: 'factor-one' }],
    [null],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one hostile answer after another
    expect(await answering(200, { factors }).provider.verifiedFactors('t')).toEqual({
      ok: false,
      fault: 'malformed',
    });
  }
  expect(await answering(401, { msg: 'no' }).provider.verifiedFactors('t')).toEqual({
    ok: false,
    fault: 'refused',
  });
});

it('C59: a user carrying large metadata beside its factors is still read, and a user past the bound is not', async () => {
  const factors = [{ id: 'factor-one', factor_type: 'totp', status: 'verified' }];
  const large = answering(200, { user_metadata: { profile: 'x'.repeat(20_000) }, factors });
  expect(await large.provider.verifiedFactors('t')).toEqual({ ok: true, value: ['factor-one'] });

  const past = answering(200, { user_metadata: { profile: 'x'.repeat(1024 * 1024) }, factors });
  expect(await past.provider.verifiedFactors('t')).toEqual({ ok: false, fault: 'oversized' });
});
