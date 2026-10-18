// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1: the stored outcome and end code reach the task through the
// existing `task.execution` read (#1655, R1), so the task needs no new read.
// Each run carries `runOutcome`, its latest attempt's stop or null.
//
// The record stays where it belongs (design "Data shapes"): `run_outcomes`
// has row security by business, forced, and no role but its owner may update
// or delete a row, the worker's role included. The execution read across a
// business, a client and a person still answers nothing of the stopped run:
// no outcome, no code, no attempt id, no canary.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  executeAgentCommand,
  executeRead,
  isCommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { cq8World } from '../runtime/cq-8-world.ts';
import { noDatabase, readAs, readIn, useAw06World, w } from '../runtime/aw-06-world.ts';
import { appliedDetail, asPerson, liveWork, type Work } from '../runtime/schedules-harness.ts';
import { attemptOfLease } from './run-outcomes-read.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('r1read');

interface RunOutcomeView {
  readonly attemptId: string;
  readonly outcome: string;
  readonly endCode: string;
}

/** The `runOutcome` the read gives one run, or undefined when the read carries none. */
const runOutcomeIn = (answer: unknown, runId: string): RunOutcomeView | null | undefined => {
  const runs = (answer as { execution?: { runs?: readonly Record<string, unknown>[] } }).execution
    ?.runs;
  const run = runs?.find((candidate) => candidate['runId'] === runId);
  return run?.['runOutcome'] as RunOutcomeView | null | undefined;
};

const cancel = async (work: Work): Promise<void> => {
  appliedDetail(
    await asPerson(w.s, {
      command: 'task.cancel',
      operationId: randomUUID(),
      recordId: work.taskId,
      lineageId: work.proposal['lineageId'],
      reason: 'stopped so its outcome is read',
    }),
    'cancel',
  );
};

it('the execution read gives a stopped run its stored outcome and end code, and a live run null', async () => {
  const stopped = await liveWork(w.s, `r1-read-stopped-${randomUUID()}`, 1_000);
  const live = await liveWork(w.s, `r1-read-live-${randomUUID()}`, 1_000);
  await cancel(stopped);
  const { attemptId } = await attemptOfLease(
    w.s.db.admin,
    w.s.business,
    String(stopped.picked['leaseId']),
  );

  const read = await readAs(w.s.decider, stopped.taskId);
  expect(runOutcomeIn(read, String(stopped.picked['runId']))).toStrictEqual({
    attemptId,
    outcome: 'cancelled',
    endCode: 'TASK_CANCELLED',
  });
  const liveRead = await readAs(w.s.decider, live.taskId);
  expect(runOutcomeIn(liveRead, String(live.picked['runId']))).toBeNull();
});

it('the read across another business, another client and another person answers none of a stopped run: no outcome, code, attempt id or canary', async () => {
  const canary = `r1-read-canary-${randomUUID()}`;
  const crossed = await liveWork(w.s, canary, 1_000);
  const own = await liveWork(w.s, `r1-read-own-${randomUUID()}`, 1_000);
  await cancel(crossed);
  const { attemptId } = await attemptOfLease(
    w.s.db.admin,
    w.s.business,
    String(crossed.picked['leaseId']),
  );
  const world = cq8World(w.s);

  const other = await world.party(`r1read-other`);
  const business = await readIn(other.id, other.member, crossed.taskId);
  await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await grantTo(tx, w.s.decider, 'share'),
  );
  const first = await world.client(w.s.business, w.s.decider, 'r1read-c1', own.taskId);
  await world.client(w.s.business, w.s.decider, 'r1read-c2', crossed.taskId);
  const client = await executeRead(w.s.db.app, w.s.business, first.presented, {
    read: 'task.execution',
    recordId: crossed.taskId,
    cursor: 0,
  } as never);
  const person = await executeAgentCommand(
    w.s.db.app,
    w.s.business,
    w.s.agent,
    String(own.picked['credential']),
    { command: 'task.execution', operationId: randomUUID(), recordId: crossed.taskId } as never,
  );

  // Positive control: the owner's read names the stop.
  expect(JSON.stringify(await readAs(w.s.decider, crossed.taskId))).toContain('TASK_CANCELLED');
  const hidden = [canary, crossed.taskId, attemptId, 'TASK_CANCELLED', 'runOutcome'];
  for (const [name, answer] of [
    ['another business', business],
    ['another client', client],
    ['another person under a live delegation', person],
  ] as const) {
    expect(isCommandRefusal(answer), name).toBe(true);
    const body = JSON.stringify(answer);
    for (const needle of hidden) expect(body.includes(needle), `${name}: ${needle}`).toBe(false);
  }
});

it('run_outcomes is kept to its business by forced row security, and no role but its owner can change or remove a row', async () => {
  const [table] = await w.s.db.admin.execute<{
    readonly secured: boolean;
    readonly forced: boolean;
    readonly owner: string;
  }>(
    `select c.relrowsecurity as secured, c.relforcerowsecurity as forced,
            pg_get_userbyid(c.relowner) as owner
       from pg_class c where c.oid = to_regclass('public.run_outcomes')`,
    [],
  );
  expect(table, 'the run_outcomes table').toBeDefined();
  expect(table?.secured).toBe(true);
  expect(table?.forced).toBe(true);

  const changers = await w.s.db.admin.execute<{ readonly role: string; readonly right: string }>(
    `select r.rolname as role, p.right
       from pg_roles r cross join (values ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(right)
      where not r.rolsuper and r.rolname <> $1 and r.rolname not like 'pg\\_%'
        and has_table_privilege(r.oid, 'public.run_outcomes', p.right)`,
    [table?.owner ?? ''],
  );
  // Every effective role, the worker's (`ops_astro_worker`) and the app's included.
  expect(changers).toStrictEqual([]);
});
