// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI: a task's assignee is a person or an agent of the business,
// and `task.assign` sets either. The assigner must direct the agent: own it,
// or hold `agent:assign`. The assignment stays until a person changes it:
// revoking or expiring a delegation takes nothing back. Four eyes counts the
// agent as its owner; reads name the agent and its owner, and say apart from
// that whether a run of it is in progress; assignment starts no run.
// The crossings (business, client, person) are task-assign-ai-isolation.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { revokeDelegation } from '../../packages/core-records/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { codeOf } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import {
  aiWorld,
  assign,
  assignEvents,
  created,
  directsEvery,
  heldAs,
  holder,
  minted,
  offered,
  ownedAgent,
  type AiWorld,
} from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('task-assign-ai: DATABASE_URL is unset, so nothing ran.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('ai');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** The agent ids an offered list holds. */
const ids = (list: unknown): unknown =>
  (list as { agentId: string }[] | undefined)?.map((one) => one.agentId);

const counted = async (table: 'leases' | 'reservations' | 'delegations'): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.${table} where business_id = $1`,
        [w.world.business],
      )
    )[0]?.n ?? '0',
  );

describe.skipIf(serverUrl === undefined)('Assign to AI: you hand a task to your agent', () => {
  it('the owner assigns their agent with no delegation; it replaces any person assignee', async () => {
    const task = await created(w, w.p, 'Brief the agent');
    await assign(w, w.p, task, { assignee: w.p.personId });
    const agent = await ownedAgent(w, w.p, 'Penny');
    const answer = await assign(w, w.p, task, { agent });
    expect(codeOf(answer)).toBe('not-a-refusal');
    expect(await holder(w, task)).toStrictEqual({ agent, person: null });
  });

  it('the person unassign action clears an agent holder', async () => {
    const task = await created(w, w.p, 'Sol unassign');
    const agent = await ownedAgent(w, w.p);
    expect(codeOf(await assign(w, w.p, task, { agent }))).toBe('not-a-refusal');
    expect(codeOf(await assign(w, w.q, task, { assignee: null }))).toBe('not-a-refusal');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });

  it('unassign the agent: anyone who may assign on the task clears it', async () => {
    const task = await created(w, w.p, 'Unassigned');
    const agent = await ownedAgent(w, w.p);
    await assign(w, w.p, task, { agent });
    expect(codeOf(await assign(w, w.q, task, { agent: null }))).toBe('not-a-refusal');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI: what an assignment writes', () => {
  it('audit read-back: the assignment is one applied task.assign event on the task', async () => {
    const task = await created(w, w.p, 'Audited');
    const agent = await ownedAgent(w, w.p);
    const before = await assignEvents(w, task);
    await assign(w, w.p, task, { agent });
    expect(await assignEvents(w, task)).toBe(before + 1);
  });

  it('a person and an agent at once is refused, and nothing is written', async () => {
    const task = await created(w, w.p, 'One kind');
    const agent = await ownedAgent(w, w.p);
    const answer = await assign(w, w.p, task, { agent, assignee: w.p.personId });
    expect(codeOf(answer)).toBe('FIELD_VALUE_INVALID');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });

  it('assignment starts no run: no reservation, lease or delegation', async () => {
    const task = await created(w, w.p, 'Nothing starts');
    const agent = await ownedAgent(w, w.p);
    const before = [
      await counted('leases'),
      await counted('reservations'),
      await counted('delegations'),
    ];
    expect(codeOf(await assign(w, w.p, task, { agent }))).toBe('not-a-refusal');
    expect([
      await counted('leases'),
      await counted('reservations'),
      await counted('delegations'),
    ]).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI: who may direct the agent', () => {
  it('another person’s agent is refused SCOPE_NOT_GRANTED, its owner’s assign grants included', async () => {
    const task = await created(w, w.p, 'Mine');
    const agent = await ownedAgent(w, w.p);
    const answer = await assign(w, w.q, task, { agent });
    expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(answer)).not.toContain(agent);
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });

  it('agent:assign over the business lets a person direct another person’s agent', async () => {
    const task = await created(w, w.q, 'Directed');
    const agent = await ownedAgent(w, w.p, 'Shared helper');
    const directing = await w.world.decider('director');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, directing, 'assign');
    });
    expect(codeOf(await assign(w, directing, task, { agent }))).toBe('SCOPE_NOT_GRANTED');
    const grant = await directsEvery(w, directing);
    expect(codeOf(await assign(w, directing, task, { agent }))).toBe('not-a-refusal');
    expect((await holder(w, task))?.agent).toBe(agent);
    // A revoked grant directs nothing: the next assignment is refused, the held one stays.
    await w.world.db.admin.execute(`update public.grants set revoked_at = now() where id = $1`, [
      grant,
    ]);
    const other = await created(w, w.q, 'Directed again');
    expect(codeOf(await assign(w, directing, other, { agent }))).toBe('SCOPE_NOT_GRANTED');
    expect((await holder(w, task))?.agent).toBe(agent);
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI: what the assigner must hold', () => {
  it('a person without task:assign is refused SCOPE_NOT_GRANTED, even for their own agent', async () => {
    const task = await created(w, w.p, 'Refused');
    const stranger = await enrol(w.world.db.app, w.world.business, 'stranger');
    const agent = await ownedAgent(w, stranger);
    const answer = await w.world.asPerson(stranger, {
      command: 'task.assign',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: 1,
      fields: { agent },
    });
    expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });

  it('a person actor, a deactivated agent and a delegation id are not agents: NOT_FOUND', async () => {
    const task = await created(w, w.p, 'Not an agent');
    const switchedOff = await ownedAgent(w, w.p);
    await w.world.db.admin.execute(
      `update public.actors set active = false, deactivated_at = now() where id = $1`,
      [switchedOff],
    );
    const delegation = await minted(w, w.p, task);
    for (const agent of [w.p.actorId, switchedOff, delegation, randomUUID()]) {
      // eslint-disable-next-line no-await-in-loop -- four refusals in turn
      expect(codeOf(await assign(w, w.p, task, { agent }))).toBe('NOT_FOUND');
    }
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI: the assignment stays', () => {
  it('revoking and expiring the agent’s delegations leaves the task assigned, unaudited', async () => {
    const task = await created(w, w.p, 'Held');
    const agent = await ownedAgent(w, w.p);
    const retired = await minted(w, w.p, task, agent);
    const revoked = await minted(w, w.p, task, agent);
    const expired = await minted(w, w.p, task, agent);
    expect(codeOf(await assign(w, w.p, task, { agent }))).toBe('not-a-refusal');
    const before = await assignEvents(w, task);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await revokeDelegation(tx, retired, 'work_retired');
    });
    await w.world.revokeDelegation(revoked);
    await w.world.db.admin.execute(
      `update public.delegations
          set granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        where id = $1`,
      [expired],
    );
    expect(await holder(w, task)).toStrictEqual({ agent, person: null });
    expect(await assignEvents(w, task)).toBe(before);
  });

  it('the read names the agent and its owner, and live says only whether a run is going', async () => {
    const task = await created(w, w.p, 'Read back');
    const agent = await ownedAgent(w, w.p, 'Reader');
    await assign(w, w.p, task, { agent });
    const expected = {
      agentId: agent,
      name: 'Reader',
      owner: { personId: w.p.personId, name: expect.any(String) as unknown },
      live: false,
    };
    // Every person who reads the task sees who holds it, not only its owner.
    expect(await heldAs(w, w.p, task)).toMatchObject(expected);
    expect(await heldAs(w, w.q, task)).toMatchObject(expected);
    const run = await minted(w, w.p, task, agent);
    expect(await heldAs(w, w.q, task)).toMatchObject({ ...expected, live: true });
    await w.world.revokeDelegation(run);
    expect(await heldAs(w, w.q, task)).toMatchObject(expected);
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI: four eyes and the control', () => {
  it('four eyes counts the agent as its owner: the owner cannot decide the gate', async () => {
    const task = await created(w, w.q, 'Gated');
    const agent = await ownedAgent(w, w.p);
    await assign(w, w.p, task, { agent });
    const gate = await proposed(task);
    expect(codeOf(await decide(w.p, gate))).toBe('FOUR_EYES_REQUIRED');
    expect(codeOf(await decide(w.q, gate))).toBe('not-a-refusal');
  });

  it('the control lists the agents the reader may direct, by name', async () => {
    const task = await created(w, w.p, 'Offered');
    const mine = await ownedAgent(w, w.p, 'Aardvark');
    const theirs = await ownedAgent(w, w.q, 'Aardwolf');
    const offeredToP = ids(await offered(w, w.p, task)) as string[];
    expect(offeredToP).toContain(mine);
    expect(offeredToP).not.toContain(theirs);
    expect(ids(await offered(w, w.q, task))).toContain(theirs);
    expect(ids(await offered(w, w.q, task))).not.toContain(mine);
  });
});

async function proposed(task: string): Promise<{ gateId: string; versionId: string }> {
  const answer: CommandResult = await w.world.asPerson(w.q, {
    command: 'task.propose',
    operationId: randomUUID(),
    recordId: task,
    expectedRevision: Number(
      (
        await w.world.db.admin.execute<{ readonly r: string }>(
          `select revision::text as r from public.records where id = $1`,
          [task],
        )
      )[0]?.r,
    ),
    purpose: `gate_${randomUUID().slice(0, 8)}`,
    maximumMinor: 3_000,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  if (isCommandRefusal(answer)) throw new Error(`task.propose refused ${answer.code}`);
  const detail = answer.detail as { gateId: string; versionId: string };
  return { gateId: detail.gateId, versionId: detail.versionId };
}

const decide = async (by: AiWorld['p'], gate: { gateId: string; versionId: string }) =>
  await w.world.asPerson(by, {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: gate.gateId,
    versionId: gate.versionId,
    decision: 'approve',
    note: 'a second person decides',
  });
