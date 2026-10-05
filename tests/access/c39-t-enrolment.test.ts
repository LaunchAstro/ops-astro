// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: accepting an invitation on its one-time link. The newest
// live link makes one login at the login provider, through custody, for the
// invitation's one enduring person, spends every token the invitation has
// and records `invitation accepted` and `login created` as the system's; the
// answer opens no session. Every other link (replayed, expired, revoked,
// replaced by a resend, unknown) is refused alike and asks nothing. An
// address that already holds a login gets none and is told to sign in, in
// the one answer shape, naming no business. A token reaches only its own
// business. A hostile provider answer, and the login it may have made, are
// `c39-t-enrolment-recovery.test.ts`'s.
//
// Not here: `C39-T second factor first` waits on C59, which this branch
// does not carry yet.

import { describe, expect, it } from 'vitest';
import { acceptInvitation } from '../../packages/core-commands/src/index.ts';
import { resolveLogin, type Session } from '../../packages/core-records/src/index.ts';
import {
  e,
  enrolVia,
  invited,
  mountOver,
  passwordFor,
  rowsIn,
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
  storedText,
  w,
} from './c39-t-world.ts';

useEnrolWorld();

const REFUSED = { status: 404, body: { code: 'ENROLMENT_LINK_INVALID' }, cookie: null };

/** The login a provider subject resolves to in one business, or the refusal's code. */
async function sessionOf(business: string, subject: string): Promise<Session | string> {
  return await w.db.app.withBusiness(business, async (tx) => {
    const resolved = await resolveLogin(tx, { provider: 'supabase', subject });
    return 'code' in resolved ? resolved.code : resolved;
  });
}

/** The identity rows a business holds, to show a refusal wrote none. */
async function identityRows(business: string): Promise<readonly number[]> {
  const tables = ['logins', 'person_logins', 'memberships', 'actors', 'person_identifiers'];
  return await Promise.all(tables.map(async (table) => await rowsIn(table, business)));
}

/** The invitation's person, as the database holds it. */
async function personOf(invitationId: string): Promise<string> {
  const [row] = await w.db.admin.execute<{ person_id: string }>(
    'select person_id from public.invitations where id = $1',
    [invitationId],
  );
  return String(row?.person_id);
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T enrolment', () => {
  // eslint-disable-next-line max-lines-per-function -- the accept, its rows, its audit and its replay
  it('C39-T enrolment: the newest link makes one login for the invited person, spends every token of the invitation and records both acts, opening no session', async () => {
    e.users.mode('accept');
    const address = addressFor('enrols');
    const { id } = await invited(c.admin, address);
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    expect(await send(id)).toMatchObject({ ok: true });
    const token = tokenTo(address);
    // The resend spent the link before it (SEC27 F5); its own is live.
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 1, tokens: 2 });
    const people = await peopleIn(w.alpha);
    const password = passwordFor();
    const asked = e.users.received.length;

    expect(await enrolVia(token, password)).toStrictEqual({
      status: 200,
      body: { state: 'enrolled' },
      cookie: null,
    });
    // One login asked for, the invited address confirmed, under custody's key.
    expect(e.users.received).toHaveLength(asked + 1);
    expect(e.users.received.at(-1)).toMatchObject({
      path: '/auth/v1/admin/users',
      authorization: `Bearer ${e.key}`,
      body: { email: address, password, email_confirm: true },
    });
    const subject = String(e.users.users.get(address));
    expect(e.users.received.at(-1)?.body['id']).toBe(subject);
    expect(await spentOf(id)).toStrictEqual({ state: 'accepted', spent: 2, tokens: 2 });
    // Bound to the invitation's one enduring person: no person is made at accept.
    expect(await peopleIn(w.alpha)).toBe(people);
    const session = await sessionOf(w.alpha, subject);
    expect(session).toMatchObject({ businessId: w.alpha, personId: await personOf(id) });
    expect(session).toMatchObject({ roleKey: 'member' });
    const audit = await auditOf(id);
    expect(audit.map((row) => row.command)).toStrictEqual([
      'invitation.create',
      'invitation.resend',
      'invitation.accept',
    ]);
    const [login] = await w.db.admin.execute<{ id: string; worker: string }>(
      `select l.id, a.kind as worker from public.logins l
         join public.audit_events ev on ev.subject_record_id = l.id
         join public.actors a on a.id = ev.actor_id
        where l.subject = $1 and ev.command = 'login.create'`,
      [subject],
    );
    expect(login?.worker).toBe('worker');
    expect((await storedText()).includes(password)).toBe(false);

    // Used a second time, the link does nothing and asks nothing.
    const before = await identityRows(w.alpha);
    expect(await enrolVia(token, passwordFor())).toStrictEqual(REFUSED);
    expect(e.users.received).toHaveLength(asked + 1);
    expect(await identityRows(w.alpha)).toStrictEqual(before);
  });

  // eslint-disable-next-line max-lines-per-function -- five ways a link stops being live, and one control
  it('C39-T enrolment: a replayed, expired, revoked or resent-older link, or one never issued, is refused alike and changes nothing', async () => {
    e.users.mode('accept');
    // Replayed: accepted once already.
    const replayed = await invited(c.admin, addressFor('replayed'));
    expect((await enrolVia(replayed.token)).body).toStrictEqual({ state: 'enrolled' });
    // Expired: the invitation's lifetime has passed.
    const expired = await invited(c.admin, addressFor('expired'));
    await w.db.admin.execute(
      `update public.invitations set expires_at = now() - interval '1 minute' where id = $1`,
      [expired.id],
    );
    // Revoked by an administrator.
    const revoked = await invited(c.admin, addressFor('revoked'));
    expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: revoked.id }))).toBe(
      'applied',
    );
    // Resent: the older link is replaced by the newer one.
    const resentAddress = addressFor('resent');
    const older = await invited(c.admin, resentAddress);
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: older.id }))).toBe(
      'applied',
    );
    expect(await send(older.id)).toMatchObject({ ok: true });
    const newer = tokenTo(resentAddress);
    expect(newer).not.toBe(older.token);

    const never = Buffer.alloc(32, 7).toString('base64url');
    const asked = e.users.received.length;
    const rows = await identityRows(w.alpha);
    for (const [name, token] of [
      ['replayed', replayed.token],
      ['expired', expired.token],
      ['revoked', revoked.token],
      ['resent-older', older.token],
      ['never issued', never],
      ['malformed', `${never}=`],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await enrolVia(token), name).toStrictEqual(REFUSED);
    }
    expect(e.users.received).toHaveLength(asked);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    // The older link was spent by the resend (SEC27 F5), and no refusal spent another.
    expect(await spentOf(older.id)).toStrictEqual({ state: 'pending', spent: 1, tokens: 2 });
    expect((await spentOf(expired.id)).spent).toBe(0);
    // The control: the resend's own link is live.
    expect((await enrolVia(newer)).body).toStrictEqual({ state: 'enrolled' });
  });

  it('C39-T enrolment: a password out of bounds is refused before the link is looked at', async () => {
    e.users.mode('accept');
    const { id, token } = await invited(c.admin, addressFor('short-password'));
    const asked = e.users.received.length;
    for (const password of ['short', 'x'.repeat(73)]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await enrolVia(token, password)).toStrictEqual({
        status: 400,
        body: { code: 'PASSWORD_INVALID' },
        cookie: null,
      });
    }
    expect(e.users.received).toHaveLength(asked);
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
  });

  it('C39-T enrolment: a password the provider refuses is PASSWORD_INVALID, never sign_in, and nothing is made, set or spent', async () => {
    e.users.mode('weak_password');
    const address = addressFor('weak-password');
    const { id, token } = await invited(c.admin, address);
    const asked = e.users.received.length;
    expect(await enrolVia(token)).toStrictEqual({
      status: 400,
      body: { code: 'PASSWORD_INVALID' },
      cookie: null,
    });
    // The create alone was asked: a refused password is no reason to adopt a login.
    expect(e.users.received.slice(asked).map((one) => one.method)).toStrictEqual(['POST']);
    expect(e.users.users.has(address)).toBe(false);
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
    e.users.mode('accept');
    expect((await enrolVia(token)).body).toStrictEqual({ state: 'enrolled' });
  });

  // eslint-disable-next-line max-lines-per-function -- the login elsewhere, and the control beside it
  it('C39-T no account oracle: accepting for an address that holds a login elsewhere makes none, spends nothing and answers in the one shape, naming no business', async () => {
    e.users.mode('accept');
    const address = addressFor('enrolled-in-bravo');
    const bravo = await invited(c.bravoAdmin, address, w.bravo);
    expect((await enrolVia(bravo.token)).body).toStrictEqual({ state: 'enrolled' });
    const alpha = await invited(c.admin, address);
    const rows = await identityRows(w.alpha);

    const answer = await enrolVia(alpha.token);
    expect(answer).toStrictEqual({ status: 200, body: { state: 'sign_in' }, cookie: null });
    const text = JSON.stringify(answer);
    for (const named of [w.bravo, 'bravo', 'Bravo', bravo.id]) expect(text).not.toContain(named);
    // Nothing made, nothing spent: the link still stands for the signed-in leg.
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await spentOf(alpha.id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });

    // The control: a new address answers in the same shape, one key, `state`.
    const fresh = await invited(c.admin, addressFor('new-address'));
    const control = await enrolVia(fresh.token);
    expect(Object.keys(control.body)).toStrictEqual(Object.keys(answer.body));
    expect(control.status).toBe(answer.status);
  });

  // eslint-disable-next-line max-lines-per-function -- the business, person and client crossings
  it('C39-T isolation: a token of one business accepts nothing in another, binds only its own invitation person and grants no client', async () => {
    e.users.mode('accept');
    const address = addressFor('two-businesses');
    const alpha = await invited(c.admin, address);
    const bravo = await invited(c.bravoAdmin, address, w.bravo);
    const bravoRows = await identityRows(w.bravo);

    // Alpha's token, looked for in bravo alone, is a link never issued there.
    const onlyBravo = mountOver([w.bravo]);
    expect(await enrolVia(alpha.token, passwordFor(), onlyBravo)).toStrictEqual(REFUSED);
    const direct = await acceptInvitation(w.db.app, [w.bravo], w.broker, {
      token: alpha.token,
      password: passwordFor(),
    });
    expect(direct).toStrictEqual({ ok: false, code: 'ENROLMENT_LINK_INVALID' });
    expect(await spentOf(alpha.id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });

    // Accepted in alpha: bravo's rows and bravo's own invitation do not move.
    expect((await enrolVia(alpha.token)).body).toStrictEqual({ state: 'enrolled' });
    expect(await identityRows(w.bravo)).toStrictEqual(bravoRows);
    expect(await spentOf(bravo.id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
    const subject = String(e.users.users.get(address));
    expect(await sessionOf(w.bravo, subject)).toBe('AUTH_NO_MEMBERSHIP');

    // The person crossing: the login is the invitation's person, and no one else's.
    const session = await sessionOf(w.alpha, subject);
    const person = await personOf(alpha.id);
    expect(session).toMatchObject({ personId: person });
    for (const other of [c.admin, c.second, c.member, c.clientSharer]) {
      expect(person).not.toBe(other.personId);
    }
    const [mapped] = await w.db.admin.execute<{ n: string }>(
      `select count(*)::text as n from public.person_logins pl
         join public.logins l on l.id = pl.login_id
        where l.subject = $1`,
      [subject],
    );
    expect(Number(mapped?.n)).toBe(1);
    // The client crossing: the new person holds no grant, on client A or anywhere.
    const [grants] = await w.db.admin.execute<{ n: string }>(
      `select count(*)::text as n from public.grants
        where subject_kind = 'person' and subject_id = $1`,
      [person],
    );
    expect(Number(grants?.n)).toBe(0);
  });

  it('C39-T enrolment: a login the provider made while its answer came too late does not stop the same link enrolling the invited person', async () => {
    const { id, token } = await invited(c.admin, addressFor('made-late'));
    e.users.mode('made_late');
    expect(await enrolVia(token)).toStrictEqual({
      status: 503,
      body: { code: 'ENROLMENT_UNAVAILABLE' },
      cookie: null,
    });
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });

    // The link was spent on nothing, so its holder tries again and is enrolled.
    e.users.mode('accept');
    expect(await enrolVia(token)).toStrictEqual({
      status: 200,
      body: { state: 'enrolled' },
      cookie: null,
    });
    expect(await spentOf(id)).toStrictEqual({ state: 'accepted', spent: 1, tokens: 1 });
  }, 30_000);
});
