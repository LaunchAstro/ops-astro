// SPDX-License-Identifier: AGPL-3.0-only
//
// REV9 proof (C39-T, signed-in accept joined with the token-only accept): a
// login one business's accept stranded at the provider, bound by its holder
// in another business while that first business's link is being accepted
// again, is never set by that link. The every-business bound check runs
// before the create and outside the login id's lock; under the lock only the
// link's own business is checked, so a bind that lands in between is missed
// and the adopting PUT sets a login another business has bound. No logins
// row is ever deleted, so the strand (a late or faulted create) is the
// reachable way into this window, not a removed binding.

import { describe, expect, it } from 'vitest';
import {
  bindVia,
  boundTo,
  e,
  enrolVia,
  invited,
  loginOf,
  useEnrolWorld,
} from './c39-t-enrol-world.ts';
import { addressFor, c, noDatabase, w } from './c39-t-world.ts';

useEnrolWorld();

describe.skipIf(noDatabase)('REV9 proof, the strand race', () => {
  it('Opus proof, races and timing: a stranded login bound by its holder in another business while the first business link is accepted again is never set or bound by that link', async () => {
    const address = addressFor('rev9-strand-race');
    const alpha = await invited(c.admin, address);
    // Alpha's accept makes the login under alpha's id and its answer comes too late: bound nowhere.
    e.users.mode('made_late');
    expect((await enrolVia(alpha.token)).status).toBe(503);
    e.users.mode('accept');
    const subject = String(e.users.users.get(address));
    const password = e.users.passwords.get(subject);
    const bravo = await invited(c.bravoAdmin, address, w.bravo);

    // Alpha's link is used again. Its every-business check has passed (bound nowhere) when its
    // create reaches the provider; the holder's signed-in bind in bravo lands right then.
    let joined: unknown;
    const from = e.users.received.length;
    e.users.beforeNext(async () => {
      joined = await bindVia(bravo.token, loginOf(subject));
    });
    const again = await enrolVia(alpha.token);
    expect(joined).toStrictEqual({ status: 200, body: { state: 'joined' }, cookie: null });
    expect(await boundTo(w.bravo, subject)).toBeDefined();

    // A login another business has bound is never set by this link, and the link is told to sign in.
    expect(e.users.received.slice(from).filter((one) => one.method === 'PUT')).toHaveLength(0);
    expect(e.users.passwords.get(subject)).toBe(password);
    expect(again).toStrictEqual({ status: 200, body: { state: 'sign_in' }, cookie: null });
    expect(await boundTo(w.alpha, subject)).toBeUndefined();
  }, 30_000);
});
