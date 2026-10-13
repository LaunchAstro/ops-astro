// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent write is judged again after its last wait, with the locks held.
// The door reads the agent's mapping, its session and its delegation without
// a lock, so a stop that commits while the write waits must still refuse it,
// and a write that holds its locks first must make the stop wait for it.
// Every step is ordered by what Postgres reports (`pg_blocking_pids`), never
// by a sleep.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, holdRow, waiterOf, type Held } from '../support/lock-wait-race.ts';
import { codeOf, type AgentWorld } from './agent-fixture.ts';
import {
  pendingStop,
  stopCase,
  stopNow,
  stopWaitsBehindWrite,
  tracked,
  type StopCase,
  WHOLE_STOP,
  type StopLeg,
} from './agent-stop-shape.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'commands/agent-write-after-stop: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const worlds: AgentWorld[] = [];

async function newCase(part: string): Promise<StopCase> {
  const test = await stopCase(part);
  worlds.push(test.world);
  return test;
}

/** The task row held `for update`, so the comment parks in its handler, past the door. */
async function holdTask(test: StopCase): Promise<Held> {
  return await holdRow(
    test.world.db,
    'select 1 from public.records where business_id = $1 and id = $2 for update',
    [test.world.business, test.picked.taskId],
  );
}

/** The write parks in its handler, the stop of `legs` commits, the write goes on. */
async function refusedAfterCommittedStop(
  part: string,
  legs: readonly StopLeg[],
  code: string,
): Promise<void> {
  const test = await newCase(part);
  const before = await test.world.commentsOn(test.picked.taskId);
  const task = await holdTask(test);
  const write = tracked(test.comment());
  await waiterOf(test.world.db, task);

  await stopNow(test.world.db, test.target, legs);
  await task.letGo();

  expect(codeOf(await write.promise)).toBe(code);
  expect(await test.world.commentsOn(test.picked.taskId)).toBe(before);
}

async function stopWaitsForTheWrite(): Promise<void> {
  const test = await newCase('aws_waits');
  const before = await test.world.commentsOn(test.picked.taskId);
  // The audit chain held elsewhere: the write parks at its last wait, its
  // judgement's row locks already taken.
  const chain = await hold(test.world.db, async (execute) => {
    await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [test.world.business]);
  });
  const write = tracked(test.comment());
  await waiterOf(test.world.db, chain);

  const stop = await pendingStop(test.world.db, test.target);
  const stopping = tracked(stop.letGo());
  const seen = await stopWaitsBehindWrite(test.world.db, stop, chain, stopping.settled);
  await chain.letGo();
  const written = await write.promise;
  await stopping.promise;

  expect(seen).toBe('waiting behind the write');
  expect(isCommandRefusal(written)).toBe(false);
  expect(await test.world.commentsOn(test.picked.taskId)).toBe(before + 1);
  // The stop committed after the write, and holds from then on.
  expect(codeOf(await test.comment())).toBe('AUTH_NO_AGENT_IDENTITY');
}

async function revokedHandbackRefused(): Promise<void> {
  const test = await newCase('aws_handback');
  const leaseId = String(test.picked.detail['leaseId']);
  const lease = await holdRow(
    test.world.db,
    'select 1 from public.leases where business_id = $1 and id = $2 for update',
    [test.world.business, leaseId],
  );
  const handback = tracked(
    test.call({
      command: 'task.handback',
      operationId: randomUUID(),
      leaseId,
      fence: Number(test.picked.detail['fence']),
      outcome: 'completed',
      report: { wrote: 'a draft' },
    }),
  );
  await waiterOf(test.world.db, lease);

  await stopNow(test.world.db, test.target, ['delegation']);
  await lease.letGo();

  expect(codeOf(await handback.promise)).toBe('DELEGATION_NOT_LIVE');
  const rows = await test.world.db.admin.execute<{ readonly settled: boolean }>(
    `select settled_at is not null as settled from public.delegations
      where business_id = $1 and agent_actor_id = $2`,
    [test.world.business, test.world.agentActorId],
  );
  expect(rows.map((row) => row.settled)).toStrictEqual([false]);
}

describe.skipIf(serverUrl === undefined)('an agent write judged after its last wait', () => {
  afterEach(async () => {
    await Promise.all(worlds.splice(0).map(async (world) => await world.drop()));
  });

  it('a plain agent write after a committed stop is refused', async () => {
    await refusedAfterCommittedStop('aws_whole', WHOLE_STOP, 'AUTH_NO_AGENT_IDENTITY');
  });

  it.each<[StopLeg, string]>([
    ['delegation', 'DELEGATION_NOT_LIVE'],
    ['identity', 'AUTH_NO_AGENT_IDENTITY'],
    ['session', 'AUTH_SESSION_EXPIRED'],
  ])(
    'a plain agent write after a committed stop of its %s alone is refused %s',
    async (leg, code) => {
      await refusedAfterCommittedStop(`aws_${leg}`, [leg], code);
    },
  );

  it('a stop waits for a write holding its locks', stopWaitsForTheWrite);

  it(
    'a handback whose delegation a stop revoked while it waited is refused',
    revokedHandbackRefused,
  );
});
