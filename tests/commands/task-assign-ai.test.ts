// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI: a task's assignee is a person or a delegation (an agent), and
// `task.assign` sets either. Only the delegating person assigns their own
// agent, only where its delegation reaches, only while it is live; revoking
// it clears it from every task it holds, one audited change each; four eyes
// counts the agent as its delegating person; assignment starts no run.
// The crossings (business, client, person) are task-assign-ai-isolation.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { revokeDelegation } from '../../packages/core-records/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { codeOf } from './agent-fixture.ts';
import { enrol } from './fixture.ts';
import {
  aiWorld,
  assign,
  assignEvents,
  created,
  holder,
  minted,
  offered,
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

/** The delegation ids an offered list holds. */
const ids = (list: unknown): unknown =>
  (list as { delegationId: string }[] | undefined)?.map((one) => one.delegationId);

const counted = async (table: 'leases' | 'reservations'): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.${table} where business_id = $1`,
        [w.world.business],
      )
    )[0]?.n ?? '0',
  );

describe.skipIf(serverUrl === undefined)('Assign to AI: you assign your own agent', () => {
  it('the person unassign action clears an agent holder', async () => {
    const task = await created(w, w.p, 'Sol unassign');
    const agent = await minted(w, w.p, task);
    expect(codeOf(await assign(w, w.p, task, { agent }))).toBe('not-a-refusal');
    expect(codeOf(await assign(w, w.q, task, { assignee: null }))).toBe('not-a-refusal');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });

  it('the delegating person assigns their own agent; it replaces any person assignee', async () => {
    const task = await created(w, w.p, 'Brief the agent');
    await assign(w, w.p, task, { assignee: w.p.personId });
    const agent = await minted(w, w.p, task);
    const answer = await assign(w, w.p, task, { agent });
    expect(codeOf(answer)).toBe('not-a-refusal');
    expect(await holder(w, task)).toStrictEqual({ agent, person: null });
  });

  it('audit read-back: the assignment is one applied task.assign event on the task', async () => {
    const task = await created(w, w.p, 'Audited');
    const agent = await minted(w, w.p, task);
    const before = await assignEvents(w, task);
    await assign(w, w.p, task, { agent });
    expect(await assignEvents(w, task)).toBe(before + 1);
  });

  it('a person and an agent at once is refused, and nothing is written', async () => {
    const task = await created(w, w.p, 'One kind');
    const agent = await minted(w, w.p, task);
    const answer = await assign(w, w.p, task, { agent, assignee: w.p.personId });
    expect(codeOf(answer)).toBe('FIELD_VALUE_INVALID');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });

  it('assignment starts no run: no reservation and no lease', async () => {
    const task = await created(w, w.p, 'Nothing starts');
    const agent = await minted(w, w.p, task);
    const [leases, reservations] = [await counted('leases'), await counted('reservations')];
    await assign(w, w.p, task, { agent });
    expect([await counted('leases'), await counted('reservations')]).toStrictEqual([
      leases,
      reservations,
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI: who, and while live', () => {
  it('another person’s agent refused, a manager’s grants included: NOT_FOUND, nothing named', async () => {
    const task = await created(w, w.p, 'Mine');
    const agent = await minted(w, w.p, task);
    const answer = await assign(w, w.q, task, { agent });
    expect(codeOf(answer)).toBe('NOT_FOUND');
    expect(JSON.stringify(answer)).not.toContain(agent);
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });

  it('task:write refused: a person without assign is refused SCOPE_NOT_GRANTED', async () => {
    const task = await created(w, w.p, 'Refused');
    const agent = await minted(w, w.p, task);
    const stranger = await enrol(w.world.db.app, w.world.business, 'stranger');
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

  it('revoked delegation refused: DELEGATION_NOT_LIVE', async () => {
    const task = await created(w, w.p, 'Revoked first');
    const agent = await minted(w, w.p, task);
    await w.world.revokeDelegation(agent);
    expect(codeOf(await assign(w, w.p, task, { agent }))).toBe('DELEGATION_NOT_LIVE');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });

  it('unassign the agent: anyone who may assign on the task clears it', async () => {
    const task = await created(w, w.p, 'Unassigned');
    const agent = await minted(w, w.p, task);
    await assign(w, w.p, task, { agent });
    expect(codeOf(await assign(w, w.q, task, { agent: null }))).toBe('not-a-refusal');
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI: revoke clears held tasks', () => {
  it('revoke preserves an agent value on a non-task record', async () => {
    const task = await created(w, w.p, 'Sol non-task revoke');
    const agent = await minted(w, w.p, task);
    const other = await w.world.db.admin.execute<{
      readonly id: string;
      readonly record_type_id: string;
    }>(
      `select r.id, r.record_type_id from public.records r join public.record_types t
         on t.business_id = r.business_id and t.id = r.record_type_id
        where r.business_id = $1 and t.key <> 'task' limit 1`,
      [w.world.business],
    );
    const recordId = other[0]?.id;
    if (recordId === undefined) throw new Error('Sol proof: no non-task record exists');
    await w.world.db.admin.execute(
      `insert into public.field_defs
         (business_id, id, record_type_id, key, label, value_type, slot,
          write_mode, owning_operation, visibility_class, origin)
       values ($1, $2, $3, 'agent', 'Agent', 'uuid', null, 'generic', null, 'internal', 'preset')`,
      [w.world.business, randomUUID(), other[0]?.record_type_id],
    );
    await w.world.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('agent', $2::text) where id = $1`,
      [recordId, agent],
    );
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await revokeDelegation(tx, agent, 'work_retired');
    });
    const kept = await w.world.db.admin.execute<{ readonly agent: string | null }>(
      `select data ->> 'agent' as agent from public.records where id = $1`,
      [recordId],
    );
    expect(kept[0]?.agent).toBe(agent);
  });

  it('a runtime-cause revoke audits every cleared task', async () => {
    const task = await created(w, w.p, 'Sol runtime revoke');
    const agent = await minted(w, w.p, task);
    expect(codeOf(await assign(w, w.p, task, { agent }))).toBe('not-a-refusal');
    const before = await assignEvents(w, task);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await revokeDelegation(tx, agent, 'work_retired');
    });
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
    expect(await assignEvents(w, task)).toBe(before + 1);
  });

  it('revoking the delegation clears it from its task, one audited change', async () => {
    const task = await created(w, w.p, 'Held');
    const agent = await minted(w, w.p, task);
    await assign(w, w.p, task, { agent });
    const before = await assignEvents(w, task);
    await w.world.revokeDelegation(agent);
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
    expect(await assignEvents(w, task)).toBe(before + 1);
  });

  it('revoke racing assign: the delegation row lock orders them, and no task holds a revoked agent', async () => {
    for (let round = 0; round < 3; round += 1) {
      /* eslint-disable no-await-in-loop -- each round races one pair */
      const task = await created(w, w.p, `Race ${String(round)}`);
      const agent = await minted(w, w.p, task);
      const [answer] = await Promise.all([
        assign(w, w.p, task, { agent }),
        w.world.revokeDelegation(agent),
      ]);
      expect(['not-a-refusal', 'DELEGATION_NOT_LIVE', 'VERSION_STALE']).toContain(codeOf(answer));
      expect((await holder(w, task))?.agent).toBeNull();
      /* eslint-enable no-await-in-loop */
    }
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI: four eyes and the control', () => {
  it('four eyes with the agent assignee refused: its delegating person cannot decide the gate', async () => {
    const task = await created(w, w.p, 'Gated');
    const agent = await minted(w, w.p, task);
    await assign(w, w.p, task, { agent });
    const gate = await proposed(task);
    expect(codeOf(await decide(w.p, gate))).toBe('FOUR_EYES_REQUIRED');
    expect(codeOf(await decide(w.q, gate))).toBe('not-a-refusal');
  });

  it('the control lists only my agents that reach the task', async () => {
    const task = await created(w, w.p, 'Offered');
    const mine = await minted(w, w.p, task);
    const theirs = await minted(w, w.q, task);
    const elsewhere = await minted(w, w.p, await created(w, w.p, 'Elsewhere'));
    expect(ids(await offered(w, w.p, task))).toStrictEqual([mine]);
    expect(ids(await offered(w, w.q, task))).toStrictEqual([theirs]);
    expect(JSON.stringify(await offered(w, w.p, task))).not.toContain(elsewhere);
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
