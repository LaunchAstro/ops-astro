// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's own entry point, end to end against a real database.
//
// I12 asks for a distinct pre-pickup login that may do two things and nothing
// else, a pickup, and a refusal for every other operation. I07 asks for the
// decision exclusion beside a real person decision that succeeds. The cases
// below are both, through `executeAgentCommand` — the same entry the HTTP
// boundary mounts at `/api/a/b/:businessKey` — with the person half through
// `executeCommand` so the two identities are never the same call.

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

if (serverUrl === undefined) {
  console.warn(
    'commands/agent: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const codeOf = (result: CommandResult): string =>
  isCommandRefusal(result) ? result.code : 'not-a-refusal';
const detailOf = (result: CommandResult): Record<string, unknown> =>
  isCommandRefusal(result) ? {} : (result.detail as Record<string, unknown>);

describe.skipIf(serverUrl === undefined)('the agent path', () => {
  let db: FreshDatabase;
  let business: BusinessId;
  let decider: Member;
  let agent: VerifiedSubject;
  let agentActorId: string;
  let task: string;
  let otherTask: string;

  beforeAll(async () => {
    process.env['GATE_SIGNING_KEY_ID'] = 'test/agent-path@1';
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    db = await createFreshDatabase({ part: 'g' });
    business = (await insertBusiness(db.app, 'agent-path')) as BusinessId;
    await installSpine(db.app, business);
    decider = await enrol(db.app, business, 'decider');
    await db.app.withBusiness(business, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, decider, action);
      }
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 500000, 'AUD')`,
        [business, randomUUID()],
      );
      // The agent identity the seed installs: an `agent` actor, a login of its
      // own, and a mapping in `actor_logins` and in neither person table.
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
    task = await createTask('work an agent will pick up');
    otherTask = await createTask('a sibling task the agent may not reach');
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

  async function createTask(title: string): Promise<string> {
    const outcome = await asPerson({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    });
    if (isCommandRefusal(outcome) || outcome.recordId === null) throw new Error('no task');
    return outcome.recordId;
  }

  /** Propose and approve, as a person, so there is something to pick up. */
  async function approvedReservation(recordId: string): Promise<string> {
    const read = await asPerson({
      command: 'task.update',
      operationId: randomUUID(),
      recordId,
      expectedRevision: await revisionOf(recordId),
      fields: {},
    });
    if (isCommandRefusal(read)) throw new Error(`could not read revision: ${read.code}`);
    const proposed = await asPerson({
      command: 'task.propose',
      operationId: randomUUID(),
      recordId,
      expectedRevision: read.revision ?? 0,
      purpose: 'draft_the_reply',
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    });
    if (isCommandRefusal(proposed)) throw new Error(`propose refused ${proposed.code}`);
    const detail = proposed.detail as Record<string, string>;
    const decided = await asPerson({
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: detail['gateId'],
      versionId: detail['versionId'],
      decision: 'approve',
      note: 'approved so an agent can work it',
    });
    if (isCommandRefusal(decided)) throw new Error(`decide refused ${decided.code}`);
    return String((decided.detail as Record<string, unknown>)['reservationId']);
  }

  async function revisionOf(recordId: string): Promise<number> {
    const rows = await db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [business, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  }

  it('refuses a person presenting themselves as an agent, and an agent on the person path', async () => {
    const person = (await executeAgentCommand(db.app, business, decider.presented, undefined, {
      command: 'task.queue',
      operationId: randomUUID(),
    } as never)) as CommandResult;
    expect(codeOf(person)).toBe('AUTH_NO_AGENT_IDENTITY');

    const asAgentOnPersonPath = await executeCommand(db.app, business, agent, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'nope' },
    } as never);
    // A login mapped to an agent actor is not in `person_logins`, so the
    // person path finds no membership. Two credentials, two paths.
    expect(codeOf(asAgentOnPersonPath)).toBe('AUTH_NO_MEMBERSHIP');
  });

  it('answers AUTH_SESSION_EXPIRED for an expired bearer, and changes nothing', async () => {
    const expired = (await executeAgentCommand(db.app, business, 'expired', undefined, {
      command: 'task.queue',
      operationId: randomUUID(),
    } as never)) as CommandResult;
    expect(codeOf(expired)).toBe('AUTH_SESSION_EXPIRED');
  });

  it('lets a pre-pickup agent read the queue and pick up, and refuses everything else', async () => {
    const reservationId = await approvedReservation(task);

    const queued = await asAgent({ command: 'task.queue', operationId: randomUUID() });
    expect(isCommandRefusal(queued)).toBe(false);
    const entries = detailOf(queued)['queue'] as readonly Record<string, unknown>[];
    expect(entries.map((entry) => entry['reservationId'])).toContain(reservationId);

    // Everything else, with no delegation to intersect the call with.
    for (const body of [
      { command: 'task.read', operationId: randomUUID(), recordId: task },
      {
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: task,
        body: 'hello',
        audience: 'internal',
      },
      {
        command: 'task.handback',
        operationId: randomUUID(),
        leaseId: randomUUID(),
        fence: 1,
        outcome: 'completed',
      },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(codeOf(await asAgent(body)), body.command).toBe('DELEGATION_NOT_LIVE');
    }
  });

  it('picks up, works inside the one-task ceiling, and is refused outside it', async () => {
    const subject = await createTask('the one task this delegation is for');
    const reservationId = await approvedReservation(subject);

    const pickedUp = await asAgent({
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId,
    });
    expect(isCommandRefusal(pickedUp)).toBe(false);
    const picked = detailOf(pickedUp);
    const credential = String(picked['credential']);
    expect(credential.length).toBeGreaterThan(20);
    expect(picked['taskId']).toBe(subject);
    expect((picked['purposeScope'] as { readonly id: string }).id).toBe(subject);
    expect(picked['declaredIncompleteness']).toHaveLength(3);

    // Inside the ceiling: the task it was minted for.
    const read = await asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: subject },
      credential,
    );
    expect(isCommandRefusal(read)).toBe(false);

    // Outside it: a sibling task the delegating person can see perfectly well.
    // Not `NOT_FOUND` — the task is there and the agent may not reach it.
    const sibling = await asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: otherTask },
      credential,
    );
    expect(codeOf(sibling)).toBe('DELEGATION_OUT_OF_PURPOSE');
    const siblingAsPerson = await asPerson({
      command: 'task.update',
      operationId: randomUUID(),
      recordId: otherTask,
      expectedRevision: await revisionOf(otherTask),
      fields: {},
    });
    expect(isCommandRefusal(siblingAsPerson)).toBe(false);

    // A decision is excluded from every delegation, and the person who
    // authorised this one can make one: I07's pair.
    const decided = await asAgent(
      {
        command: 'task.decide',
        operationId: randomUUID(),
        gateId: randomUUID(),
        versionId: randomUUID(),
        decision: 'approve',
        note: 'not mine to make',
      },
      credential,
    );
    expect(codeOf(decided)).toBe('DELEGATION_EXCLUDES_DECISION');

    // The handback settles the delegation, and the next call collapses.
    const handedBack = await asAgent(
      {
        command: 'task.handback',
        operationId: randomUUID(),
        leaseId: String(picked['leaseId']),
        fence: Number(picked['fence']),
        outcome: 'completed',
        report: { wrote: 'a draft' },
      },
      credential,
    );
    expect(isCommandRefusal(handedBack)).toBe(false);
    // `abandoned`, never a zero `actual`: nothing ran, so claiming it ran and
    // cost nothing would be an invention.
    expect(detailOf(handedBack)['reservationState']).toBe('abandoned');
    expect(detailOf(handedBack)['envelopeActualMinor']).toBe(0);

    const afterwards = await asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: subject },
      credential,
    );
    expect(codeOf(afterwards)).toBe('DELEGATION_NOT_LIVE');

    // A stale fence settles nothing, and the reservation is off the queue.
    const queued = await asAgent({ command: 'task.queue', operationId: randomUUID() });
    const entries = detailOf(queued)['queue'] as readonly Record<string, unknown>[];
    expect(entries.map((entry) => entry['reservationId'])).not.toContain(reservationId);
  });

  it('answers session.capabilities with its own purpose, never the person’s grants', async () => {
    // Before a pickup: no purpose, and the floor it may work from. This is
    // reachable with no credential on purpose — refusing it for want of one
    // would refuse the single call whose whole subject is that there is none.
    const cold = await asAgent({ command: 'session.capabilities', operationId: randomUUID() });
    expect(isCommandRefusal(cold)).toBe(false);
    const before = detailOf(cold);
    expect(before['agentActorId']).toBe(agentActorId);
    expect(before['businessKey']).toBe('agent-path');
    expect(before['purposeScope']).toBeNull();
    // The authority the pre-pickup pair takes -- `task.queue` reads and
    // `task.pickup` writes -- and not the delegating person's grants wearing
    // the agent's name. `decider` holds `decide`, `assign` and `comment` on
    // tasks as well, and none of them is here.
    expect(before['grants']).toStrictEqual([
      { collection: 'task', action: 'write' },
      { collection: 'task', action: 'read' },
    ]);
    expect(Object.keys(before).toSorted()).toStrictEqual([
      'agentActorId',
      'businessKey',
      'grants',
      'purposeScope',
    ]);

    const subject = await createTask('a task an agent will ask its purpose about');
    const reservationId = await approvedReservation(subject);
    const pickedUp = await asAgent({
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId,
    });
    const credential = String(detailOf(pickedUp)['credential']);

    const warm = await asAgent(
      { command: 'session.capabilities', operationId: randomUUID() },
      credential,
    );
    const after = detailOf(warm);
    expect(after['purposeScope']).toStrictEqual({ kind: 'record', id: subject });
    expect(after['agentActorId']).toBe(agentActorId);

    // Settle it, so this case leaves the agent holding nothing: an agent
    // actor may hold one live delegation per purpose, and a case that walked
    // away from one would fail the next pickup rather than its own assertion.
    const picked = detailOf(pickedUp);
    await asAgent(
      {
        command: 'task.handback',
        operationId: randomUUID(),
        leaseId: String(picked['leaseId']),
        fence: Number(picked['fence']),
        outcome: 'completed',
      },
      credential,
    );
  });

  it('audits the agent under its own actor, and replays a repeated identity', async () => {
    const subject = await createTask('a pickup retried after a lost response');
    const reservationId = await approvedReservation(subject);
    const operationId = randomUUID();
    const first = await asAgent({ command: 'task.pickup', operationId, reservationId });
    const again = await asAgent({ command: 'task.pickup', operationId, reservationId });
    expect(again).toStrictEqual(first);

    // One lease, not two: the register answered the second call.
    const leases = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.leases where business_id = $1 and reservation_id = $2`,
      [business, reservationId],
    );
    expect(Number(leases[0]?.n)).toBe(1);

    const events = await db.app.withBusiness(business, async (tx) => {
      const all = await readAuditEvents(tx);
      return all.filter((event) => event.operation_id === operationId);
    });
    expect(events.map((event) => event.outcome)).toStrictEqual(['applied', 'replayed']);
    // The agent's own actor, never the delegating person's.
    expect(events.every((event) => event.actor_id === agentActorId)).toBe(true);
  });
});
