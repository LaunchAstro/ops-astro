// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the local tick completes a task's agent run on the owner's
// laptop. Approved work waiting in the queue is picked up by the agent through
// the production agent entry, its one model step goes through the broker's
// own executor (the server's wiring, custody's process, the replay provider on
// loopback until the join swaps in `local-claude`), and the run is handed back
// completed. Outside OPS_ENVIRONMENT=local nothing is picked up and no call is
// made, and a tick for one business never picks up another's work.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { openReplayBroker, type ReplayBroker } from '../broker/replay-broker.ts';
import {
  approve,
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { runQueuedTasks, type TaskTick } from '../../apps/local-agent/tick.ts';

const serverUrl = databaseUrlFromEnvironment();
const LOCAL = { OPS_ENVIRONMENT: 'local' } as const;

/** A task with work proposed and approved, waiting in the queue for an agent. */
const queued = async (world: Schedules): Promise<string> => {
  const taskId = await createTask(world, `Local run ${randomUUID().slice(0, 8)}`);
  const proposal = await propose(world, taskId, { maximumMinor: 2_000, purpose: freshPurpose() });
  await approve(world, proposal);
  return taskId;
};

const callsOn = async (world: Schedules, taskId: string): Promise<number> => {
  const [row] = await world.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.model_calls c
       join public.leases l on l.business_id = c.business_id and l.id = c.lease_id
       join public.planned_runs r on r.business_id = l.business_id and r.id = l.run_id
      where r.task_id = $1`,
    [taskId],
  );
  return Number(row?.n);
};

const liveLeasesOn = async (world: Schedules, taskId: string): Promise<number> => {
  const [row] = await world.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.leases l
       join public.planned_runs r on r.business_id = l.business_id and r.id = l.run_id
      where r.task_id = $1 and l.state = 'live'`,
    [taskId],
  );
  return Number(row?.n);
};

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)("LA-1 local tick: a task's agent run", () => {
  let s: Schedules;
  let other: Schedules;
  let broker: ReplayBroker;

  const optionsFor = (
    world: Schedules,
    environment: Record<string, string | undefined> = LOCAL,
  ): TaskTick => ({
    environment,
    database: world.db.app,
    businessId: world.business,
    agent: world.agent,
    executeModelCall: broker.executor,
    operation: REPLAY_COMPOSE.key,
    // Bound to the run's own task, which a person entered (S3).
    fieldsFor: (entry) => [{ name: 'tone', from: { recordId: entry.taskId, key: 'title' } }],
  });

  beforeAll(async () => {
    s = await openSchedules('la1task', 1_000_000);
    other = await seedSchedules(s.db, 'la1other', 1_000_000);
    broker = await openReplayBroker();
  }, 180_000);

  afterAll(async () => {
    await broker?.close();
    await s?.db.drop();
  });

  it("a task's agent run completes locally: picked up, one model call, handed back", async () => {
    const taskId = await queued(s);
    const sentBefore = broker.provider.seen.length;

    const ran = await runQueuedTasks(optionsFor(s));

    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    const mine = ran.ran.filter((r) => r.taskId === taskId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ taskId, outcome: 'completed', reply: 'Drafted.' });
    expect(broker.provider.seen.length).toBe(sentBefore + 1);
    expect(await callsOn(s, taskId)).toBe(1);
    expect(await liveLeasesOn(s, taskId)).toBe(0);
  });

  it('a tick with nothing queued picks nothing up and makes no model call', async () => {
    await runQueuedTasks(optionsFor(s));
    const sentBefore = broker.provider.seen.length;

    const ran = await runQueuedTasks(optionsFor(s));

    expect(ran).toEqual({ ok: true, ran: [] });
    expect(broker.provider.seen.length).toBe(sentBefore);
  });

  it.each([
    ['staging', { OPS_ENVIRONMENT: 'staging' }],
    ['production', { OPS_ENVIRONMENT: 'production' }],
    ['unset', {}],
  ])('a tick refuses outside OPS_ENVIRONMENT=local (%s): no pickup, no call', async (_, env) => {
    const taskId = await queued(s);
    const sentBefore = broker.provider.seen.length;

    const ran = await runQueuedTasks(optionsFor(s, env));

    expect(ran).toEqual({ ok: false, code: 'LOCAL_ONLY', message: expect.any(String) });
    expect(broker.provider.seen.length).toBe(sentBefore);
    expect(await callsOn(s, taskId)).toBe(0);
    expect(await liveLeasesOn(s, taskId)).toBe(0);
    // Leave the queue empty for the cases after this one.
    await runQueuedTasks(optionsFor(s));
  });

  it("a tick for one business never picks up another business's queued work", async () => {
    const othersTask = await queued(other);
    const sentBefore = broker.provider.seen.length;

    const ran = await runQueuedTasks(optionsFor(s));

    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.ran.map((r) => r.taskId)).not.toContain(othersTask);
    expect(broker.provider.seen.length).toBe(sentBefore);
    expect(await callsOn(other, othersTask)).toBe(0);
    expect(await liveLeasesOn(other, othersTask)).toBe(0);
  });
});
