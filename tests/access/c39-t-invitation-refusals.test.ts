// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P1: who may invite, and what one business, client or person
// can reach of another's invitations. `invitation.create`, `invitation.resend`
// and `invitation.revoke` each ask `access:share` on the whole business, a
// person's key no agent holds; another business's invitation answers as one
// nobody issued; and the tables answer only the business the transaction is
// set to. Acts are rate limited per address and per account, counted from the
// records. The records themselves are `c39-t-invitations.test.ts`.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INVITATION_LIMITS } from '../../packages/core-commands/src/commands/invitations.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { declarationOf } from '../../packages/core-wire/src/surface.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { insertAgentActor, insertAgentMapping, insertLogin } from '../identity/fixture.ts';
import {
  addressFor,
  as,
  c,
  codeOf,
  countFor,
  invitationRow,
  invite,
  noDatabase,
  send,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

const COMMANDS = ['invitation.create', 'invitation.resend', 'invitation.revoke'] as const;

const bodyFor = (command: string, invitationId: string): Record<string, unknown> =>
  command === 'invitation.create'
    ? { name: 'Nope', email: addressFor('nope'), role: 'member' }
    : { invitationId };

async function invitationCount(business: string): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: string }>(
    'select count(*)::text as n from public.invitations where business_id = $1',
    [business],
  );
  return Number(row?.n);
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T invitation refusals and isolation', () => {
  // eslint-disable-next-line max-lines-per-function -- one key, every command and every caller without it
  it('C39-T refusal access:share: without access:share on the whole business each invitation command is refused and writes nothing', async () => {
    const id = await invite(c.admin);
    const count = await invitationCount(w.alpha);
    // A member holding other keys, and a person holding access:share on one client only.
    for (const who of [c.member, c.clientSharer]) {
      for (const command of COMMANDS) {
        // eslint-disable-next-line no-await-in-loop
        const refused = await as(who, command, bodyFor(command, id));
        expect({ command, code: codeOf(refused) }).toStrictEqual({
          command,
          code: 'SCOPE_NOT_GRANTED',
        });
      }
    }
    expect(await invitationCount(w.alpha)).toBe(count);
    expect(await invitationRow(id)).toMatchObject({ state: 'pending', revision: 1 });
    const refusals = await w.db.admin.execute<{ command: string }>(
      `select command from public.audit_events
        where business_id = $1 and outcome = 'refused' and refusal_code = 'SCOPE_NOT_GRANTED'
          and actor_id = any($2::uuid[]) and command like 'invitation.%'`,
      [w.alpha, [c.member.actorId, c.clientSharer.actorId]],
    );
    expect(refusals).toHaveLength(COMMANDS.length * 2);

    // The key's whole row: access:share, asked of the business, never an agent's.
    for (const command of COMMANDS) {
      expect(declarationOf(command)).toMatchObject({
        collection: 'access',
        action: 'share',
        authorisedOn: 'business',
        agent: 'never',
      });
    }
    // An agent signed in to the business reaches none of them.
    const agent = await w.db.app.withBusiness(w.alpha, async (tx) => {
      const actor = await insertAgentActor(tx);
      const subject = `agent-${randomUUID()}`;
      await insertAgentMapping(tx, await insertLogin(tx, subject), actor, c.admin.actorId);
      return { provider: 'supabase' as const, subject };
    });
    for (const command of COMMANDS) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await executeAgentCommand(w.db.app, w.alpha, agent, undefined, {
        command,
        operationId: randomUUID(),
        ...bodyFor(command, id),
      } as never);
      expect(codeOf(refused)).toBe('DELEGATION_EXCLUDES_OPERATION');
    }
    expect(await invitationCount(w.alpha)).toBe(count);
    expect(await invitationRow(id)).toMatchObject({ state: 'pending', revision: 1 });
  });

  // eslint-disable-next-line max-lines-per-function -- the three crossings, one case each
  it('C39-T isolation: another business, another client and another person never reach an invitation', async () => {
    w.provider.mode('accept');
    const alphas = await invite(c.admin);
    expect(await send(alphas)).toMatchObject({ ok: true });
    const fabricated = randomUUID();

    // Business to business: bravo's holder of the key is told what an unissued id is told.
    for (const command of ['invitation.resend', 'invitation.revoke']) {
      // eslint-disable-next-line no-await-in-loop
      const crossing = await as(c.bravoAdmin, command, { invitationId: alphas });
      // eslint-disable-next-line no-await-in-loop
      const unissued = await as(c.bravoAdmin, command, { invitationId: fabricated });
      expect(crossing).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(crossing)).toBe(JSON.stringify(unissued));
    }
    expect(await invitationRow(alphas)).toMatchObject({ state: 'pending', revision: 1 });
    // The send in bravo's business finds nothing of alpha's, and nothing leaves.
    const received = w.provider.received.length;
    expect(await send(alphas, w.bravo)).toStrictEqual({
      ok: false,
      code: 'INVITATION_NOT_PENDING',
    });
    expect(w.provider.received.length).toBe(received);
    // The rows themselves: set to bravo, the tables hold none of alpha's.
    const seen = await w.db.app.withBusiness(w.bravo, async (tx) => {
      const counts: Record<string, string> = {};
      for (const table of ['invitations', 'enrolment_tokens', 'invitation_delivery_attempts']) {
        // eslint-disable-next-line no-await-in-loop
        const [row] = await tx.query<{ n: string }>(`select count(*)::text as n from ${table}`);
        counts[table] = row?.n ?? '';
      }
      return counts;
    });
    expect(seen).toStrictEqual({
      invitations: '0',
      enrolment_tokens: '0',
      invitation_delivery_attempts: '0',
    });
    // An address bravo knows is no answer about alpha, and the other way round.
    const shared = addressFor('both');
    expect(
      codeOf(
        await as(c.bravoAdmin, 'invitation.create', {
          name: 'In bravo',
          email: shared,
          role: 'member',
        }),
      ),
    ).toBe('applied');
    expect(
      codeOf(
        await as(c.admin, 'invitation.create', {
          name: 'In alpha',
          email: shared,
          role: 'member',
        }),
      ),
    ).toBe('applied');

    // Same business, wrong client: access:share on client A reaches no invitation.
    for (const command of ['invitation.resend', 'invitation.revoke']) {
      // eslint-disable-next-line no-await-in-loop
      const wrong = await as(c.clientSharer, command, { invitationId: alphas });
      expect(codeOf(wrong)).toBe('SCOPE_NOT_GRANTED');
    }
    expect(await invitationRow(alphas)).toMatchObject({ state: 'pending', revision: 1 });

    // Person to person: the invitation makes a new person of its own, never an
    // existing one of the same name, and its send reaches its own address only.
    const made = await as(c.admin, 'invitation.create', {
      name: 'Mo Member',
      email: addressFor('mo'),
      role: 'member',
    });
    const named = String(isCommandRefusal(made) ? '' : made.recordId);
    const row = await invitationRow(named);
    expect(row?.['person_id']).not.toBe(c.member.personId);
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: named }))).toBe('applied');
    expect(await send(named)).toMatchObject({ ok: true });
    const to = (JSON.parse(w.provider.outbox.at(-1)?.body ?? '{}') as Record<string, unknown>)[
      'to'
    ];
    expect(to).toStrictEqual([row?.['address']]);
    expect(await countFor('enrolment_tokens', named)).toBe(1);
  });

  // eslint-disable-next-line max-lines-per-function -- both limits, counted from the records
  it('C39-T rate limit: invitation acts per address and per account in an hour are refused past the limit, writing nothing', async () => {
    expect(INVITATION_LIMITS).toStrictEqual({ perAddressPerHour: 3, perAccountPerHour: 30 });
    // Per address: the address's acts count whoever makes them.
    const address = addressFor('limited');
    const id = await invite(c.admin, address);
    for (let n = 1; n < INVITATION_LIMITS.perAddressPerHour; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    }
    for (const who of [c.admin, c.second]) {
      // eslint-disable-next-line no-await-in-loop
      const over = await as(who, 'invitation.resend', { invitationId: id });
      expect(over).toMatchObject({ code: 'RATE_LIMITED', names: ['email'] });
    }
    expect(await invitationRow(id)).toMatchObject({
      revision: INVITATION_LIMITS.perAddressPerHour,
    });
    // Revoked and invited again, the address is still within its hour.
    expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: id }))).toBe('applied');
    const again = await as(c.admin, 'invitation.create', {
      name: 'Again',
      email: address,
      role: 'member',
    });
    expect(again).toMatchObject({ code: 'RATE_LIMITED', names: ['email'] });

    // Per account: one person's acts across addresses.
    const busy = await enrol(w.db.app, w.alpha, 'Bo Busy');
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, busy, 'share', undefined, false, 'access');
    });
    for (let n = 0; n < INVITATION_LIMITS.perAccountPerHour; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      await invite(busy);
    }
    const over = await as(busy, 'invitation.create', {
      name: 'One too many',
      email: addressFor('over'),
      role: 'member',
    });
    expect(over).toMatchObject({ code: 'RATE_LIMITED', names: ['account'] });
    const [made] = await w.db.admin.execute<{ n: string }>(
      'select count(*)::text as n from public.invitations where created_by_actor_id = $1',
      [busy.actorId],
    );
    expect(Number(made?.n)).toBe(INVITATION_LIMITS.perAccountPerHour);
    // Another account is not held by this one's.
    expect(
      codeOf(
        await as(c.second, 'invitation.create', {
          name: 'Other account',
          email: addressFor('other'),
          role: 'member',
        }),
      ),
    ).toBe('applied');
  });
});
