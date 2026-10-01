// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P1 (records): a team invitation is created, resent, revoked and
// expired as records with their audit events; an invitation is emailed only
// after the act of a person holding `access:share`, each act one send, through
// the broker's catalogued `email.send`; the enrolment token is kept as its
// SHA-256 alone. Refusals, isolation and the rate limits are
// `c39-t-invitation-refusals.test.ts`.

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import {
  expireInvitations,
  INVITATION_LIFETIME_DAYS,
} from '../../packages/core-commands/src/commands/invitations.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  addressFor,
  linkIn,
  peopleIn,
  received,
  storedText,
  as,
  auditOf,
  c,
  codeOf,
  countFor,
  invitationRow,
  invite,
  MAIL,
  noDatabase,
  send,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

const DAY_MS = 24 * 60 * 60 * 1000;

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T invitations', () => {
  // eslint-disable-next-line max-lines-per-function -- one invitation through its whole life
  it('C39-T records: create, resend, revoke and expire each write the invitation and an audit event read back', async () => {
    const address = addressFor('Records');
    const created = await as(c.admin, 'invitation.create', {
      name: '  Rory Records ',
      email: `  ${address.toUpperCase()} `,
      role: 'member',
    });
    expect(codeOf(created)).toBe('applied');
    if (isCommandRefusal(created)) return;
    const id = String(created.recordId);
    const row = await invitationRow(id);
    expect(row).toMatchObject({
      business_id: w.alpha,
      role_key: 'member',
      address: address.toLowerCase(),
      state: 'pending',
      revision: 1,
      created_by_actor_id: c.admin.actorId,
      ended_at: null,
    });
    const expiresAt = row?.['expires_at'] as Date | undefined;
    const lifetime = (expiresAt?.getTime() ?? 0) - Date.now();
    expect(Math.abs(lifetime - INVITATION_LIFETIME_DAYS * DAY_MS)).toBeLessThan(60_000);
    const [person] = await w.db.admin.execute<{ display_name: string; business_id: string }>(
      'select display_name, business_id from public.people where id = $1',
      [row?.['person_id']],
    );
    expect(person).toStrictEqual({ display_name: 'Rory Records', business_id: w.alpha });
    expect(created.detail).toStrictEqual({ invitationId: id, state: 'pending' });

    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    expect(await invitationRow(id)).toMatchObject({ state: 'pending', revision: 2 });
    expect(codeOf(await as(c.second, 'invitation.revoke', { invitationId: id }))).toBe('applied');
    const revoked = await invitationRow(id);
    expect(revoked).toMatchObject({ state: 'revoked', revision: 3 });
    expect(revoked?.['ended_at']).toBeInstanceOf(Date);
    // An ended invitation moves no further, and the refusal writes nothing.
    for (const command of ['invitation.resend', 'invitation.revoke']) {
      // eslint-disable-next-line no-await-in-loop
      const again = await as(c.admin, command, { invitationId: id });
      expect(again).toMatchObject({ code: 'TRANSITION_NOT_PERMITTED', names: ['state'] });
    }
    expect(await invitationRow(id)).toMatchObject({ state: 'revoked', revision: 3 });
    expect((await auditOf(id)).filter((event) => event.outcome === 'applied')).toStrictEqual([
      { command: 'invitation.create', outcome: 'applied', actor_id: c.admin.actorId },
      { command: 'invitation.resend', outcome: 'applied', actor_id: c.admin.actorId },
      { command: 'invitation.revoke', outcome: 'applied', actor_id: c.second.actorId },
    ]);

    // Expiry is the system's: the business's worker writes it, and only past the lifetime.
    const lapsing = await invite(c.admin);
    const live = await invite(c.admin);
    await w.db.admin.execute(
      `update public.invitations set expires_at = now() - interval '1 minute' where id = $1`,
      [lapsing],
    );
    const expired = await expireInvitations(w.db.app, w.alpha);
    expect(expired).toStrictEqual([lapsing]);
    expect(await invitationRow(lapsing)).toMatchObject({ state: 'expired', revision: 2 });
    expect(await invitationRow(live)).toMatchObject({ state: 'pending', revision: 1 });
    const expiry = (await auditOf(lapsing)).find((e) => e.command === 'invitation.expire');
    const [worker] = await w.db.admin.execute<{ kind: string }>(
      'select kind from public.actors where id = $1',
      [expiry?.actor_id],
    );
    expect({ outcome: expiry?.outcome, kind: worker?.kind }).toStrictEqual({
      outcome: 'applied',
      kind: 'worker',
    });
    expect(await expireInvitations(w.db.app, w.alpha)).toStrictEqual([]);
    const chain = await w.db.app.withBusiness(w.alpha, async (tx) => await verifyAuditChain(tx));
    expect(chain.intact).toBe(true);
  });

  // eslint-disable-next-line max-lines-per-function -- the owner check's first half, one case
  it('C39-T invite a team member: name, email and role; one email through the broker, its link token kept as a hash only', async () => {
    w.provider.mode('accept');
    const address = addressFor('teammate');
    const id = await invite(c.admin, address, 'admin');
    const before = w.provider.received.length;
    const sent = await send(id);
    expect(sent).toMatchObject({ ok: true, state: 'accepted' });
    expect(w.provider.received.length).toBe(before + 1);
    const message = w.provider.outbox.at(-1);
    expect(message?.authorization).toBe(`Bearer ${w.key}`);
    const body = JSON.parse(message?.body ?? '{}') as Record<string, unknown>;
    expect(body['to']).toStrictEqual([address]);
    expect(body['from']).toBe(MAIL.from);
    const { link, token } = linkIn(message?.body);
    expect(link.startsWith(`${MAIL.appOrigin}/enrol/`)).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const tokens = await w.db.admin.execute<{ token_hash: string; spent_at: Date | null }>(
      'select token_hash, spent_at from public.enrolment_tokens where invitation_id = $1',
      [id],
    );
    expect(tokens).toStrictEqual([
      { token_hash: createHash('sha256').update(token).digest('hex'), spent_at: null },
    ]);
    const attempts = await w.db.admin.execute<{ state: string; evidence: string | null }>(
      `select state, evidence from public.invitation_delivery_attempts
        where invitation_id = $1 order by observed_seq`,
      [id],
    );
    expect(attempts.map((attempt) => attempt.state)).toStrictEqual(['asked', 'accepted']);
    expect(attempts[1]?.evidence).toMatch(/^provider:/u);
    // The token itself is nowhere the system keeps anything.
    expect((await storedText()).includes(token)).toBe(false);

    // What the inviter types is checked by name, and a refusal writes nothing.
    const peopleBefore = await peopleIn(w.alpha);
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ name: 'Ivy', email: 'not-an-address', role: 'member' }, 'email'],
      [{ name: 'Ivy', email: `${'x'.repeat(250)}@example.test`, role: 'member' }, 'email'],
      [{ name: '   ', email: addressFor('blank'), role: 'member' }, 'name'],
      [{ name: 'Ivy', email: addressFor('owner'), role: 'owner' }, 'role'],
      [{ name: 'Ivy', email: addressFor('shape'), role: 'Member!' }, 'role'],
    ];
    for (const [input, name] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await as(c.admin, 'invitation.create', input);
      expect(refused).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: [name] });
    }
    // A pending invitation to the address, or a member already at it, is not invited twice.
    const pending = await as(c.second, 'invitation.create', {
      name: 'Twice',
      email: address,
      role: 'member',
    });
    expect(pending).toMatchObject({ code: 'UNIQUE_VALUE_TAKEN', names: ['email'] });
    const memberAddress = addressFor('member');
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await tx.query(
        `insert into public.person_identifiers
           (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
         values ($1, $2, $3, 'email', $4, $4, 'test', 'confirmed')`,
        [tx.businessId, randomUUID(), c.member.personId, memberAddress],
      );
    });
    const existing = await as(c.admin, 'invitation.create', {
      name: 'Mo again',
      email: memberAddress,
      role: 'member',
    });
    expect(existing).toMatchObject({ code: 'UNIQUE_VALUE_TAKEN', names: ['email'] });
    expect(await peopleIn(w.alpha)).toBe(peopleBefore);
  });

  // eslint-disable-next-line max-lines-per-function -- the approval gate's one rule, act by act
  it("C39-T send only on the inviter's act: no invitation mail leaves without a recorded act of a person holding access:share", async () => {
    w.provider.mode('accept');
    // A row nobody's act created: written straight into the table, it sends nothing.
    const planted = randomUUID();
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      const person = randomUUID();
      await tx.query(
        `insert into public.people (business_id, id, display_name) values ($1, $2, 'P')`,
        [tx.businessId, person],
      );
      await tx.query(
        `insert into public.invitations
           (business_id, id, person_id, role_key, address, expires_at, created_by_actor_id)
         values ($1, $2, $3, 'member', $4, now() + interval '1 day', $5)`,
        [tx.businessId, planted, person, addressFor('planted'), c.admin.actorId],
      );
    });
    let before = received();
    expect(await send(planted)).toStrictEqual({ ok: false, code: 'NO_SEND_ACT' });
    expect(received()).toBe(before);
    expect(await countFor('enrolment_tokens', planted)).toBe(0);
    expect(await countFor('invitation_delivery_attempts', planted)).toBe(0);

    // One act, one send; a second send without a second act is refused.
    const id = await invite(c.admin);
    before = received();
    expect(await send(id)).toMatchObject({ ok: true, state: 'accepted' });
    expect(await send(id)).toStrictEqual({ ok: false, code: 'NO_SEND_ACT' });
    expect(received()).toBe(before + 1);
    // A refused act is no act.
    const refused = await as(c.member, 'invitation.resend', { invitationId: id });
    expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
    expect(await send(id)).toStrictEqual({ ok: false, code: 'NO_SEND_ACT' });
    // A resend is an act: one more send, a new token, and the first link's token is not reused.
    expect(codeOf(await as(c.second, 'invitation.resend', { invitationId: id }))).toBe('applied');
    expect(await send(id)).toMatchObject({ ok: true, state: 'accepted' });
    expect(received()).toBe(before + 2);
    const [first, second] = w.provider.outbox.slice(-2).map((m) => linkIn(m.body).token);
    expect(first).not.toBe(second);
    expect(await countFor('enrolment_tokens', id)).toBe(2);

    // A revoked or lapsed invitation sends nothing, whatever acts it had.
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: id }))).toBe('applied');
    expect(await send(id)).toStrictEqual({ ok: false, code: 'INVITATION_NOT_PENDING' });
    const lapsed = await invite(c.admin);
    await w.db.admin.execute(
      `update public.invitations set expires_at = now() - interval '1 second' where id = $1`,
      [lapsed],
    );
    expect(await send(lapsed)).toStrictEqual({ ok: false, code: 'INVITATION_NOT_PENDING' });
    expect(received()).toBe(before + 2);
  });
});
