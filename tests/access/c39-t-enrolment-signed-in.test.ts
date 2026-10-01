// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: the invitation link accepted by someone signed in with the
// login they already hold. The token is the authority over the invitation and
// the verified session says which login: the provider confirms that login's
// address is the invited one (`auth.read_user`, through custody), and the
// login is bound to the invitation's one person in this business, every
// token spent, both acts audited, no password asked and no session opened.
// Another address, an address the provider has not confirmed, a login it
// does not hold, a login this business maps to someone already and every
// dead link are refused alike and spend nothing. The token alone, isolation
// and the other business's link are `c39-t-enrolment-signed-in-isolation`'s.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  bindVia,
  e,
  enrolVia,
  heldInBravo,
  identityRows,
  invitationAddress,
  invited,
  loginOf,
  personOf,
  sessionOf,
  spentOf,
  tokenTo,
  useEnrolWorld,
} from './c39-t-enrol-world.ts';
import {
  addressFor,
  as,
  auditOf,
  c,
  codeOf,
  noDatabase,
  peopleIn,
  send,
  w,
} from './c39-t-world.ts';

useEnrolWorld();

const REFUSED = { status: 404, body: { code: 'ENROLMENT_LINK_INVALID' }, cookie: null };
const JOINED = { status: 200, body: { state: 'joined' }, cookie: null };
const PENDING = { state: 'pending', spent: 0, tokens: 1 };

/** An address held in bravo, invited in alpha: the invitation, its link and the login's bearer. */
async function holder(name: string): Promise<{ id: string; token: string; login: string }> {
  const address = addressFor(name);
  const login = loginOf(await heldInBravo(address));
  return { ...(await invited(c.admin, address)), login };
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T enrolment signed in', () => {
  // eslint-disable-next-line max-lines-per-function -- the bind, its rows, its audit, the act and the replay
  it('C39-T enrolment signed in: a login held in another business, signed in, accepts the link and is bound to the invited person, who can then act in this business', async () => {
    const address = addressFor('signed-in');
    const subject = await heldInBravo(address);
    const password = e.users.passwords.get(subject);
    const alpha = await invited(c.admin, address);
    expect((await enrolVia(alpha.token)).body).toStrictEqual({ state: 'sign_in' });
    expect(await sessionOf(w.alpha, subject)).toBe('AUTH_NO_MEMBERSHIP');
    const bravoSession = await sessionOf(w.bravo, subject);
    const people = await peopleIn(w.alpha);
    const asked = e.users.received.length;

    expect(await bindVia(alpha.token, loginOf(subject))).toStrictEqual(JOINED);
    // One read of the session's login, under custody's key; nothing made, nothing set.
    expect(e.users.received.slice(asked)).toStrictEqual([
      expect.objectContaining({
        method: 'GET',
        path: `/auth/v1/admin/users/${subject}`,
        authorization: `Bearer ${e.key}`,
      }),
    ]);
    expect(e.users.passwords.get(subject)).toBe(password);
    expect(await spentOf(alpha.id)).toStrictEqual({ state: 'accepted', spent: 1, tokens: 1 });
    expect(await peopleIn(w.alpha)).toBe(people);
    const person = await personOf(alpha.id);
    expect(await sessionOf(w.alpha, subject)).toMatchObject({
      businessId: w.alpha,
      personId: person,
      roleKey: 'member',
    });
    expect(await sessionOf(w.bravo, subject)).toStrictEqual(bravoSession);
    expect((await auditOf(alpha.id)).map((row) => row.command)).toStrictEqual([
      'invitation.create',
      'invitation.accept',
    ]);
    const [login] = await w.db.admin.execute<{ worker: string }>(
      `select a.kind as worker from public.logins l
         join public.audit_events ev on ev.subject_record_id = l.id
         join public.actors a on a.id = ev.actor_id
        where l.subject = $1 and l.business_id = $2 and ev.command = 'login.create'`,
      [subject, w.alpha],
    );
    expect(login?.worker).toBe('worker');

    // The person acts in alpha under that login: given a read, they read their own capabilities,
    // once the second factor is set up (C39-T second factor first), on a sign-in that used it.
    const [actor] = await w.db.admin.execute<{ id: string }>(
      'select id from public.actors where person_id = $1',
      [person],
    );
    const presented = { provider: 'supabase', subject };
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, { personId: person, actorId: String(actor?.id), presented }, 'read');
    });
    const capabilities = { read: 'session.capabilities' } as const;
    expect(await executeRead(w.db.app, w.alpha, presented, capabilities)).toMatchObject({
      code: 'AUTH_SECOND_FACTOR_SETUP_REQUIRED',
    });
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      const factor = { personId: person, provider: 'supabase', providerFactorId: 'factor-bound' };
      const enrolled = await recordFactorEnrolled(tx, factor);
      await recordFactorVerified(tx, { personId: person, factorId: enrolled.id, subject });
    });
    const now = Math.floor(Date.now() / 1000);
    const withFactor = {
      ...presented,
      assurance: { level: 'aal2', signedInAt: now, factorAt: now } as const,
    };
    const read = await executeRead(w.db.app, w.alpha, withFactor, capabilities);
    expect(read).toMatchObject({ personId: person });

    // Used a second time, with the same session, the link does nothing and asks nothing.
    const rows = await identityRows(w.alpha);
    const again = e.users.received.length;
    expect(await bindVia(alpha.token, loginOf(subject))).toStrictEqual(REFUSED);
    expect(e.users.received).toHaveLength(again);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
  });

  it('C39-T enrolment signed in: a session whose confirmed address is not the invited one, or that the provider does not hold, is refused alike and spends nothing', async () => {
    const address = addressFor('invited-here');
    const other = await heldInBravo(addressFor('someone-else'));
    const unconfirmed = e.users.plant(address, false);
    const alpha = await invited(c.admin, address);
    const rows = await identityRows(w.alpha);
    const asked = e.users.received.length;
    for (const [name, subject] of [
      ['another address', other],
      ['the invited address, unconfirmed', unconfirmed],
      ['a login the provider does not hold', randomUUID()],
      ['not a provider id', 'subject-made-elsewhere'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await bindVia(alpha.token, loginOf(subject)), name).toStrictEqual(REFUSED);
    }
    // Three reads at the provider; an id it could not have issued asks nothing.
    expect(e.users.received.slice(asked).map((request) => request.method)).toStrictEqual([
      'GET',
      'GET',
      'GET',
    ]);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await spentOf(alpha.id)).toStrictEqual(PENDING);

    // The control: a login made elsewhere whose address the provider confirmed is bound.
    const confirmed = e.users.plant(address, true);
    expect(await bindVia(alpha.token, loginOf(confirmed))).toStrictEqual(JOINED);
  });

  it('C39-T enrolment signed in: a login this business has mapped to another person is refused alike and spends nothing', async () => {
    e.users.mode('accept');
    const address = addressFor('mapped-here');
    const first = await invited(c.admin, address);
    expect((await enrolVia(first.token)).body).toStrictEqual({ state: 'enrolled' });
    const subject = String(e.users.users.get(address));
    const firstPerson = await personOf(first.id);
    // The first person leaves the team: their address may be invited again, their login stays theirs.
    await w.db.admin.execute(
      `update public.memberships set active = false, ended_at = now()
        where business_id = $1 and person_id = $2`,
      [w.alpha, firstPerson],
    );
    const second = await invited(c.admin, address);
    expect((await enrolVia(second.token)).body).toStrictEqual({ state: 'sign_in' });
    const rows = await identityRows(w.alpha);

    expect(await bindVia(second.token, loginOf(subject))).toStrictEqual(REFUSED);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await spentOf(second.id)).toStrictEqual(PENDING);
    const [mapped] = await w.db.admin.execute<{ person_id: string }>(
      `select pl.person_id from public.person_logins pl
         join public.logins l on l.business_id = pl.business_id and l.id = pl.login_id
        where l.business_id = $1 and l.subject = $2 and pl.active`,
      [w.alpha, subject],
    );
    expect(mapped?.person_id).toBe(firstPerson);
  });

  // eslint-disable-next-line max-lines-per-function -- five ways a link stops being live, and one control
  it('C39-T enrolment signed in: a replayed, expired, revoked or resent-older link, or one never issued, is refused alike, asks the provider nothing and changes nothing', async () => {
    const replayed = await holder('bind-replayed');
    expect(await bindVia(replayed.token, replayed.login)).toStrictEqual(JOINED);
    const expired = await holder('bind-expired');
    await w.db.admin.execute(
      `update public.invitations set expires_at = now() - interval '1 minute' where id = $1`,
      [expired.id],
    );
    const revoked = await holder('bind-revoked');
    expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: revoked.id }))).toBe(
      'applied',
    );
    const older = await holder('bind-resent');
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: older.id }))).toBe(
      'applied',
    );
    expect(await send(older.id)).toMatchObject({ ok: true });
    const newer = tokenTo(String((await invitationAddress(older.id)) ?? ''));
    expect(newer).not.toBe(older.token);

    const never = Buffer.alloc(32, 9).toString('base64url');
    const asked = e.users.received.length;
    const rows = await identityRows(w.alpha);
    for (const [name, token, login] of [
      ['replayed', replayed.token, replayed.login],
      ['expired', expired.token, expired.login],
      ['revoked', revoked.token, revoked.login],
      ['resent-older', older.token, older.login],
      ['never issued', never, older.login],
      ['malformed', `${never}=`, older.login],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await bindVia(token, login), name).toStrictEqual(REFUSED);
    }
    expect(e.users.received).toHaveLength(asked);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await spentOf(older.id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 2 });
    expect((await spentOf(expired.id)).spent).toBe(0);
    // The control: the resend's own link is live for the same session.
    expect(await bindVia(newer, older.login)).toStrictEqual(JOINED);
  });
});
