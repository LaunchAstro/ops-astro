// SPDX-License-Identifier: AGPL-3.0-only
//
// `LEASE_HELD`, reached by an ordinary caller through the command envelope.
//
// The register listed it as unproducible on the reading that a second pickup
// of a leased reservation meets `RESERVATION_NOT_CLAIMABLE` first. That is
// true of the *same* reservation only. Two reservations on one task reach it:
// the first approval opens the task's envelope, a handback releases its hold
// back to that envelope without closing it (T3), and two new lineages on the
// same task are each approved inside the envelope's room. The first pickup
// leases the task; the second meets the live lease on the task (T3 line 62:
// "Refuse LEASE_HELD while another live lease owns the work").
//
// The pickups are an agent's, through `executeAgentCommand`, as
// `unproduced-reach.test.ts` drives them. The refusal is checked on the
// command result, then for no second lease, the second reservation untouched,
// and one refused audit row in the caller's business.

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
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

const codeOf = (result: CommandResult): string =>
  isCommandRefusal(result) ? result.code : 'not-a-refusal';
const detailOf = (result: CommandResult): Record<string, unknown> =>
  isCommandRefusal(result) ? {} : (result.detail as Record<string, unknown>);

describe.skipIf(serverUrl === undefined)('LEASE_HELD, reached through commands', () => {
  let db: FreshDatabase;
  let business: BusinessId;
  let decider: Member;
  let agent: VerifiedSubject;
  let agentActorId: string;

  beforeAll(async () => {
    process.env['GATE_SIGNING_KEY_ID'] = 'test/lease-held-reach@1';
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    db = await createFreshDatabase({ part: 'lh' });
    business = (await insertBusiness(db.app, 'lease-held-reach')) as BusinessId;
    await installSpine(db.app, business);
    decider = await enrol(db.app, business, 'decider');
    await db.app.withBusiness(business, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
        // Sequential: `issueGrant` reads the granter's own rows.
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, decider, action);
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

  const asPerson = async (body: Readonly<Record<string, unknown>>): Promise<CommandResult> =>
    await executeCommand(db.app, business, decider.presented, 'api', body as never);

  const asAgent = async (
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<CommandResult> =>
    (await executeAgentCommand(
      db.app,
      business,
      agent,
      credential,
      body as never,
    )) as CommandResult;

  async function revisionOf(recordId: string): Promise<number> {
    const rows = await db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [business, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  }

  /** A new lineage on the task, approved: the reservation it holds. */
  async function approvedLineage(recordId: string, maximumMinor: number): Promise<string> {
    const proposed = await asPerson({
      command: 'task.propose',
      operationId: randomUUID(),
      recordId,
      expectedRevision: await revisionOf(recordId),
      purpose: 'draft_the_reply',
      maximumMinor,
      currency: 'AUD',
      payload: { instruction: 'draft a reply to the client' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
    });
    expect(codeOf(proposed), 'task.propose').toBe('not-a-refusal');
    const proposal = detailOf(proposed);
    const decided = await asPerson({
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'approve through the envelope',
    });
    expect(codeOf(decided), 'task.decide').toBe('not-a-refusal');
    return String(detailOf(decided)['reservationId']);
  }

  const pickUp = async (reservationId: string, operationId = randomUUID()) =>
    await asAgent({ command: 'task.pickup', operationId, reservationId });

  it('refuses the second of two approved lineages on one task while the first holds its lease', async () => {
    const created = await asPerson({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'one task, two approved lineages' },
    });
    if (isCommandRefusal(created) || created.recordId === null) throw new Error('no task');
    const taskId = created.recordId;

    // 1-2. The first approval opens the envelope; its handback releases the
    // hold back to that envelope and leaves the envelope open.
    const first = detailOf(await pickUp(await approvedLineage(taskId, 2_500)));
    const settled = await asAgent(
      {
        command: 'task.handback',
        operationId: randomUUID(),
        leaseId: String(first['leaseId']),
        fence: Number(first['fence']),
        outcome: 'completed',
        report: { wrote: 'the first draft' },
      },
      String(first['credential']),
    );
    expect(codeOf(settled), 'first handback').toBe('not-a-refusal');

    // 3. Two new lineages on the same task, each approved within the room.
    const one = await approvedLineage(taskId, 1_000);
    const two = await approvedLineage(taskId, 1_000);

    // 4. The first pickup leases the task; the second meets that lease.
    const leased = await pickUp(one);
    expect(codeOf(leased), 'first pickup').toBe('not-a-refusal');
    const leasesBefore = await db.admin.execute<{ readonly id: string }>(
      `select id from public.leases where business_id = $1 and task_id = $2 order by id`,
      [business, taskId],
    );

    const operationId = randomUUID();
    const refused = await pickUp(two, operationId);
    expect(codeOf(refused)).toBe('LEASE_HELD');

    // No second lease, and the second reservation is still held and unleased.
    const leasesAfter = await db.admin.execute<{ readonly id: string }>(
      `select id from public.leases where business_id = $1 and task_id = $2 order by id`,
      [business, taskId],
    );
    expect(leasesAfter).toStrictEqual(leasesBefore);
    const second = await db.admin.execute<{ readonly state: string; readonly lease_id: unknown }>(
      `select state, lease_id from public.reservations where business_id = $1 and id = $2`,
      [business, two],
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.state).toBe('held');
    expect(second[0]?.lease_id).toBeNull();

    // One refused audit row, in the caller's own business.
    const events = await db.app.withBusiness(business, async (tx) =>
      (await readAuditEvents(tx)).filter((event) => event.refusal_code === 'LEASE_HELD'),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('refused');
    expect(events[0]?.actor_id).toBe(agentActorId);
    expect(events[0]?.command).toBe('task.pickup');
  }, 60_000);
});
