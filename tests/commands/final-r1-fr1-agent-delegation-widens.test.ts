// SPDX-License-Identifier: AGPL-3.0-only
//
// `DELEGATION_WIDENS`, reached by an ordinary caller through the command
// envelope.
//
// The register listed it as unproducible on the reading that `task.pickup`
// mints from the authorising person's own live grants, so it cannot construct
// a delegation wider than they are. That is true at approval time only. The
// mint (`authority/delegations.ts`, `mintDelegation`) reads the approver's
// grants at business scope when the agent picks the work up, not when the
// person approved it, and a grant can stop being live in between: another
// manager revokes it through `grant.revoke`, or its `expires_at` passes. The
// agent's pickup then asks for `write` the approver no longer holds, and the
// mint refuses it.
//
// The pickup is an agent's, through `executeAgentCommand`, as
// `lease-held-reach.test.ts` drives it. The refusal is checked on the command
// result, then for no lease, no delegation, the reservation still held and
// unleased, and one refused audit row in the caller's business.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import { UNPRODUCED_CODES } from '../../packages/core-records/src/commands/register.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

const codeOf = (result: CommandResult): string =>
  isCommandRefusal(result) ? result.code : 'not-a-refusal';
const detailOf = (result: CommandResult): Record<string, unknown> =>
  isCommandRefusal(result) ? {} : (result.detail as Record<string, unknown>);

describe('the unproduced list', () => {
  it('does not name DELEGATION_WIDENS, because a pickup reaches it', () => {
    expect(UNPRODUCED_CODES.has('DELEGATION_WIDENS')).toBe(false);
  });
});

describe.skipIf(serverUrl === undefined)('DELEGATION_WIDENS, reached through commands', () => {
  let db: FreshDatabase;
  let business: BusinessId;
  let decider: Member;
  let manager: Member;
  let agent: VerifiedSubject;
  let agentActorId: string;

  beforeAll(async () => {
    process.env['GATE_SIGNING_KEY_ID'] = 'test/delegation-widens@1';
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    db = await createFreshDatabase({ part: 'dw' });
    business = (await insertBusiness(db.app, 'delegation-widens')) as BusinessId;
    await installSpine(db.app, business);
    decider = await enrol(db.app, business, 'decider');
    manager = await enrol(db.app, business, 'manager');
    await db.app.withBusiness(business, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
        // Sequential: `issueGrant` reads the granter's own rows.
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, decider, action);
      }
      for (const action of ['read', 'write', 'manage'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, manager, action);
      }
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 500000, 'AUD')`,
        [business, randomUUID()],
      );
      agentActorId = randomUUID();
      await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
        business,
        agentActorId,
      ]);
      const subject = `agent-${randomUUID()}`;
      const loginId = await insertLogin(tx, subject);
      await tx.query(
        `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [business, randomUUID(), loginId, agentActorId, decider.actorId],
      );
      agent = { provider: 'supabase', subject };
    });
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  const asPerson = async (
    member: Member,
    body: Readonly<Record<string, unknown>>,
  ): Promise<CommandResult> =>
    await executeCommand(db.app, business, member.presented, 'api', body as never);

  async function revisionOf(recordId: string): Promise<number> {
    const rows = await db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [business, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  }

  async function count(table: 'leases' | 'delegations'): Promise<number> {
    const rows = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.${table} where business_id = $1`,
      [business],
    );
    return Number(rows[0]?.n ?? '-1');
  }

  it('refuses the pickup when the approver lost task write between approval and pickup', async () => {
    const created = await asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'approved, then the approver lost write' },
    });
    if (isCommandRefusal(created) || created.recordId === null) throw new Error('no task');
    const taskId = created.recordId;

    // 1. The decider proposes and approves: the reservation is queued.
    const proposed = await asPerson(decider, {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      purpose: 'draft_the_reply',
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { instruction: 'draft a reply to the client' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
    });
    expect(codeOf(proposed), 'task.propose').toBe('not-a-refusal');
    const proposal = detailOf(proposed);
    const decided = await asPerson(decider, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'approve through the envelope',
    });
    expect(codeOf(decided), 'task.decide').toBe('not-a-refusal');
    const reservationId = String(detailOf(decided)['reservationId']);

    // 2. Another manager revokes the decider's business-scope task write
    // through the route.
    const grants = await db.admin.execute<{ readonly id: string }>(
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and scope_kind = 'business'
          and revoked_at is null`,
      [business, decider.personId],
    );
    expect(grants).toHaveLength(1);
    const revoked = await asPerson(manager, {
      command: 'grant.revoke',
      operationId: randomUUID(),
      grantId: grants[0]?.id,
    });
    expect(codeOf(revoked), 'grant.revoke').toBe('not-a-refusal');

    const leasesBefore = await count('leases');
    const delegationsBefore = await count('delegations');

    // 3. The agent, holding no credential, picks up the queued reservation.
    const operationId = randomUUID();
    const refused = (await executeAgentCommand(db.app, business, agent, undefined, {
      command: 'task.pickup',
      operationId,
      reservationId,
    } as never)) as CommandResult;
    expect(codeOf(refused)).toBe('DELEGATION_WIDENS');
    expect(isCommandRefusal(refused) && refused.refused).toBe(true);

    // No lease, no delegation, and the reservation still held and unleased.
    expect(await count('leases')).toBe(leasesBefore);
    expect(await count('delegations')).toBe(delegationsBefore);
    const reservation = await db.admin.execute<{
      readonly state: string;
      readonly lease_id: unknown;
    }>(`select state, lease_id from public.reservations where business_id = $1 and id = $2`, [
      business,
      reservationId,
    ]);
    expect(reservation).toHaveLength(1);
    expect(reservation[0]?.state).toBe('held');
    expect(reservation[0]?.lease_id).toBeNull();

    // One refused audit row, in the caller's own business.
    const events = await db.app.withBusiness(business, async (tx) =>
      (await readAuditEvents(tx)).filter((event) => event.refusal_code === 'DELEGATION_WIDENS'),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('refused');
    expect(events[0]?.actor_id).toBe(agentActorId);
    expect(events[0]?.command).toBe('task.pickup');
    expect(events[0]?.operation_id).toBe(operationId);
  }, 60_000);
});
