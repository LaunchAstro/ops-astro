// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: the signed-in accept's edges. The token alone opens no
// session and accepts nothing, and a session that ended or a cookie from
// another site is answered before the link is looked at. A token reaches only
// its own business, binds only its invitation's person in the invited role
// and leaves the login's other business as it was. A login a signed-in
// accept bound is never set again by another business's link. A hostile
// answer to the provider read binds and spends nothing.

import { describe, expect, it } from 'vitest';
import { acceptSignedIn } from '../../packages/core-commands/src/index.ts';
import type { Session } from '../../packages/core-records/src/index.ts';
import {
  bindVia,
  e,
  enrolVia,
  heldInBravo,
  identityRows,
  invited,
  loginOf,
  mountOver,
  personOf,
  sessionOf,
  spentOf,
  useEnrolWorld,
} from './c39-t-enrol-world.ts';
import type { FakeUsersMode } from './c39-t-users-fake.ts';
import { addressFor, c, noDatabase, w } from './c39-t-world.ts';

useEnrolWorld();

const REFUSED = { status: 404, body: { code: 'ENROLMENT_LINK_INVALID' }, cookie: null };
const JOINED = { status: 200, body: { state: 'joined' }, cookie: null };
const PENDING = { state: 'pending', spent: 0, tokens: 1 };

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T enrolment signed in, its edges', () => {
  it('C39-T enrolment signed in: the token alone opens no session and accepts nothing, and a session that ended is told so before the link is looked at', async () => {
    const address = addressFor('token-alone');
    const subject = await heldInBravo(address);
    const alpha = await invited(c.admin, address);
    const asked = e.users.received.length;

    expect(await bindVia(alpha.token)).toStrictEqual({
      status: 401,
      body: { code: 'AUTH_UNKNOWN_LOGIN' },
      cookie: null,
    });
    expect(await bindVia(alpha.token, 'expired')).toStrictEqual({
      status: 401,
      body: { code: 'AUTH_SESSION_EXPIRED' },
      cookie: null,
    });
    // A session cookie sent without the own-page header is another site's request.
    const crossSite = await e.app.fetch(
      new Request('http://api.test/api/b/enrol', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'ops-astro-session-ab=x' },
        body: JSON.stringify({ token: alpha.token }),
      }),
    );
    expect(crossSite.status).toBe(403);
    expect(e.users.received).toHaveLength(asked);
    expect(await spentOf(alpha.id)).toStrictEqual(PENDING);
    expect(await sessionOf(w.alpha, subject)).toBe('AUTH_NO_MEMBERSHIP');
    // The token-only route, given the same link, opens no session either.
    expect(await enrolVia(alpha.token)).toStrictEqual({
      status: 200,
      body: { state: 'sign_in' },
      cookie: null,
    });
  });

  // eslint-disable-next-line max-lines-per-function -- the business, person, role and client crossings
  it('C39-T isolation: a signed-in bind reaches only its own business, seats only the invited person, grants nothing beyond the invited role and leaves the login in its other business as it was', async () => {
    const address = addressFor('bind-two-businesses');
    const subject = await heldInBravo(address, 'admin');
    const alpha = await invited(c.admin, address);
    const bravoRows = await identityRows(w.bravo);
    const bravoSession = await sessionOf(w.bravo, subject);
    const login = { provider: 'supabase', subject };

    // Alpha's token, looked for in bravo alone, is a link never issued there, and asks nothing.
    const asked = e.users.received.length;
    expect(await bindVia(alpha.token, loginOf(subject), mountOver([w.bravo]))).toStrictEqual(
      REFUSED,
    );
    expect(
      await acceptSignedIn(w.db.app, [w.bravo], w.broker, { token: alpha.token, login }),
    ).toStrictEqual({ ok: false, code: 'ENROLMENT_LINK_INVALID' });
    expect(e.users.received).toHaveLength(asked);
    expect(await spentOf(alpha.id)).toStrictEqual(PENDING);

    // Bound in alpha: bravo's rows, and the login's bravo person and role, do not move.
    expect(await bindVia(alpha.token, loginOf(subject))).toStrictEqual(JOINED);
    expect(await identityRows(w.bravo)).toStrictEqual(bravoRows);
    expect(await sessionOf(w.bravo, subject)).toStrictEqual(bravoSession);
    expect(bravoSession).toMatchObject({ roleKey: 'admin' });

    // The person crossing: alpha maps the login to the invitation's person, and no one else.
    const person = await personOf(alpha.id);
    const cast = [c.admin, c.second, c.member, c.clientSharer, c.bravoAdmin];
    for (const other of cast) expect(person).not.toBe(other.personId);
    const mapped = await w.db.admin.execute<{ business_id: string; person_id: string }>(
      `select pl.business_id, pl.person_id from public.person_logins pl
         join public.logins l on l.business_id = pl.business_id and l.id = pl.login_id
        where l.subject = $1 and pl.active order by pl.business_id = $2`,
      [subject, w.alpha],
    );
    expect(mapped.map((row) => [row.business_id, row.person_id])).toStrictEqual([
      [w.bravo, (bravoSession as Session).personId],
      [w.alpha, person],
    ]);
    // The role and the client: the invited role, not bravo's, and no grant anywhere.
    expect(await sessionOf(w.alpha, subject)).toMatchObject({ roleKey: 'member' });
    const [grants] = await w.db.admin.execute<{ n: string }>(
      `select count(*)::text as n from public.grants
        where subject_kind = 'person' and subject_id = $1`,
      [person],
    );
    expect(Number(grants?.n)).toBe(0);
  });

  it('C39-T no account oracle: a login a signed-in accept bound in one business is never set by another business link, which answers sign_in', async () => {
    const address = addressFor('stranded-then-bound');
    const alpha = await invited(c.admin, address);
    // Alpha's accept makes the login under alpha's id, and its answer comes too late: bound nowhere.
    e.users.mode('made_late');
    expect((await enrolVia(alpha.token)).status).toBe(503);
    e.users.mode('accept');
    const subject = String(e.users.users.get(address));
    const password = e.users.passwords.get(subject);
    // Its holder, signed in with it, accepts bravo's link: the login is bound in bravo.
    const bravo = await invited(c.bravoAdmin, address, w.bravo);
    expect(await bindVia(bravo.token, loginOf(subject))).toStrictEqual(JOINED);

    // Alpha's link still stands; used, it sets nothing and is told to sign in.
    const asked = e.users.received.length;
    expect(await enrolVia(alpha.token)).toStrictEqual({
      status: 200,
      body: { state: 'sign_in' },
      cookie: null,
    });
    expect(e.users.received).toHaveLength(asked);
    expect(e.users.passwords.get(subject)).toBe(password);
    expect(await spentOf(alpha.id)).toStrictEqual(PENDING);
  }, 30_000);

  it('C39-T hostile provider: a hostile answer to the read of the signed-in login binds nothing and spends nothing, and the link then binds', async () => {
    const address = addressFor('bind-hostile');
    const subject = await heldInBravo(address);
    const alpha = await invited(c.admin, address);
    const rows = await identityRows(w.alpha);
    const modes: readonly FakeUsersMode[] = [
      'oversized',
      'redirect',
      'not_json',
      'bad_id',
      'other_id',
      'fault',
      'slow',
    ];
    for (const mode of modes) {
      e.users.mode(mode);
      // oxlint-disable-next-line no-await-in-loop
      expect(await bindVia(alpha.token, loginOf(subject)), mode).toStrictEqual({
        status: 503,
        body: { code: 'ENROLMENT_UNAVAILABLE' },
        cookie: null,
      });
    }
    e.users.mode('accept');
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await spentOf(alpha.id)).toStrictEqual(PENDING);
    expect(await bindVia(alpha.token, loginOf(subject))).toStrictEqual(JOINED);
  }, 30_000);
});
