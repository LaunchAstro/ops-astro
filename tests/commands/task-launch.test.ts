// SPDX-License-Identifier: AGPL-3.0-only
//
// Launch from the task: a person who may direct the task's agent clicks
// Launch, and a run is opened for that agent and task with a fresh delegation
// scoped to the task, waiting for the runner. Assigning started nothing; the
// click does, and starts no lease or reservation either. Refused in plain
// words, writing nothing: a task with no agent, a client's task (only
// internal tasks go to an AI agent for now), a switched-off agent, a caller
// who may not direct the agent, an agent caller, and a second Launch while a
// run is open. The crossings are task-launch-isolation.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import {
  aiWorld,
  assign,
  created,
  heldAs,
  onClient,
  ownedAgent,
  revisionOf,
  type AiWorld,
} from './ai-assign-world.ts';

/** What `codeOf` answers for a command that applied. */
const APPLIED = 'not-a-refusal';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('task-launch: DATABASE_URL is unset, so nothing ran.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('launch');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

const launch = async (by: Decider, taskId: string): Promise<CommandResult> =>
  await w.world.asPerson(by, {
    command: 'task.launch',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(w, taskId),
  });

const count = async (sql: string, ...values: unknown[]): Promise<number> =>
  Number((await w.world.db.admin.execute<{ readonly n: string }>(sql, values))[0]?.n ?? '0');

/** Launches, delegations, leases and reservations of the world's business: what a refusal must leave as it was. */
const footprint = async (): Promise<readonly number[]> =>
  await Promise.all(
    ['task_launches', 'delegations', 'leases', 'reservations'].map(
      async (table) =>
        await count(
          `select count(*)::text as n from public.${table} where business_id = $1`,
          w.world.business,
        ),
    ),
  );

/** An internal task held by a fresh agent `by` owns. */
const heldTask = async (by: Decider, title: string): Promise<{ task: string; agent: string }> => {
  const agent = await ownedAgent(w, by);
  const task = await created(w, by, title);
  expect(codeOf(await assign(w, by, task, { agent }))).toBe(APPLIED);
  return { task, agent };
};

const runOf = async (by: Decider, taskId: string): Promise<unknown> =>
  ((await heldAs(w, by, taskId)) as { run?: unknown } | null)?.run;

describe.skipIf(serverUrl === undefined)('Launch: the click opens a run for the agent', () => {
  it('opens one waiting run with a task-scoped delegation, and starts no work', async () => {
    const { task, agent } = await heldTask(w.p, 'Draft the newsletter');
    expect(await runOf(w.p, task)).toBeNull();
    const before = await footprint();
    const answer = await launch(w.p, task);
    expect(codeOf(answer)).toBe(APPLIED);
    const body = JSON.stringify(answer);
    expect(body).not.toMatch(/credential|delegation/iu);
    const runs = await w.world.db.admin.execute<{
      readonly state: string;
      readonly agent: string;
      readonly scope: string;
      readonly person: string;
      readonly collections: readonly string[];
      readonly actions: readonly string[];
      readonly hours: number;
    }>(
      `select l.state, l.agent_actor_id::text as agent, d.purpose_scope_id::text as scope,
              d.delegate_person_id::text as person, d.collections, d.actions,
              round(extract(epoch from d.expires_at - d.granted_at) / 3600)::int as hours
         from public.task_launches l
         join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
        where l.business_id = $1 and l.task_id = $2`,
      [w.world.business, task],
    );
    expect(runs).toEqual([
      {
        state: 'waiting',
        agent,
        scope: task,
        person: w.p.personId,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        hours: 8,
      },
    ]);
    const after = await footprint();
    expect(after).toEqual([before[0]! + 1, before[1]! + 1, before[2], before[3]]);
    expect(await runOf(w.p, task)).toMatchObject({ state: 'waiting' });
  });

  it('a holder of agent:assign launches an agent someone else owns', async () => {
    const { task } = await heldTask(w.q, 'Tidy the folder');
    const boss = await enrol(w.world.db.app, w.world.business, `boss-${randomUUID().slice(0, 6)}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      for (const action of ['read', 'write', 'comment', 'assign'] as const) {
        // oxlint-disable-next-line no-await-in-loop -- four grants
        await grantTo(tx, boss, action);
      }
      await grantTo(tx, boss, 'assign', undefined, false, 'agent');
    });
    expect(codeOf(await launch(boss as Decider, task))).toBe(APPLIED);
  });
});

describe.skipIf(serverUrl === undefined)('Launch: refused in plain words, writing nothing', () => {
  it('a task with no agent', async () => {
    const task = await created(w, w.p, 'Nobody holds this');
    const before = await footprint();
    const answer = await launch(w.p, task);
    expect(codeOf(answer)).toBe('LAUNCH_NO_AGENT');
    expect(await footprint()).toEqual(before);
  });

  it("a client's task: only internal tasks go to an AI agent for now", async () => {
    const { task } = await heldTask(w.p, 'Client brief');
    await onClient(w, task, randomUUID());
    const before = await footprint();
    const answer = await launch(w.p, task);
    expect(codeOf(answer)).toBe('LAUNCH_CLIENT_TASK');
    expect(JSON.stringify(answer)).toMatch(/internal/u);
    expect(await footprint()).toEqual(before);
  });

  it('a switched-off agent', async () => {
    const { task, agent } = await heldTask(w.p, 'Agent switched off');
    await w.world.db.admin.execute(
      `update public.actors set active = false, deactivated_at = now() where id = $1`,
      [agent],
    );
    const before = await footprint();
    expect(codeOf(await launch(w.p, task))).toBe('AGENT_NOT_ACTIVE');
    expect(await footprint()).toEqual(before);
  });

  it('a person who may not direct the agent, and one without task:assign', async () => {
    const { task } = await heldTask(w.p, 'Not yours to launch');
    const before = await footprint();
    expect(codeOf(await launch(w.q, task))).toBe('SCOPE_NOT_GRANTED');
    const reader = await enrol(w.world.db.app, w.world.business, `r-${randomUUID().slice(0, 6)}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, reader, 'read');
    });
    expect(codeOf(await launch(reader as Decider, task))).toBe('SCOPE_NOT_GRANTED');
    expect(await footprint()).toEqual(before);
  });

  it('an agent caller', async () => {
    const { task } = await heldTask(w.p, 'Agents do not launch');
    const before = await footprint();
    const answer = await w.world.asAgent({
      command: 'task.launch',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await revisionOf(w, task),
    });
    expect(codeOf(answer)).not.toBe(APPLIED);
    expect(await footprint()).toEqual(before);
  });

  it('a second Launch while the run is open; after it lapses, a fresh one', async () => {
    const { task } = await heldTask(w.p, 'Launch once');
    expect(codeOf(await launch(w.p, task))).toBe(APPLIED);
    const before = await footprint();
    expect(codeOf(await launch(w.p, task))).toBe('RUN_ALREADY_OPEN');
    expect(await footprint()).toEqual(before);
    await w.world.db.admin.execute(
      `update public.delegations set granted_at = now() - interval '9 hours',
              expires_at = now() - interval '1 hour'
        where purpose_scope_id = $1`,
      [task],
    );
    expect(await runOf(w.p, task)).toBeNull();
    expect(codeOf(await launch(w.p, task))).toBe(APPLIED);
    const states = await w.world.db.admin.execute<{ readonly state: string }>(
      `select state from public.task_launches where task_id = $1 order by launched_at`,
      [task],
    );
    expect(states.map((row) => row.state)).toEqual(['ended', 'waiting']);
  });

  it('two Launches at once: one run opens, the other is refused', async () => {
    const { task } = await heldTask(w.p, 'Clicked twice');
    const answers = await Promise.all([launch(w.p, task), launch(w.p, task)]);
    expect(answers.map(codeOf).toSorted()).toEqual(['RUN_ALREADY_OPEN', APPLIED].toSorted());
    expect(
      await count(`select count(*)::text as n from public.task_launches where task_id = $1`, task),
    ).toBe(1);
  });
});
