// SPDX-License-Identifier: AGPL-3.0-only
//
// #1710: a launched run that no runner takes within its bound (15 minutes
// from `launched_at`, read when the statement runs) shows in plain words on
// the task, and Launch again ends that launch, retires its delegation
// (`work_retired`) and opens a fresh run. Within the bound, and once a runner
// has taken the run, nothing changes: Launch is refused while the run is
// open. It never writes success and never retries by itself. A take and a
// Launch past the bound meet on the task row and the launch row, in either
// order, and leave exactly one open run.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import { aiWorld, heldAs, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { APPLIED, launchedTask, take, takenAs } from './take-launch-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('unanswered launch: DATABASE_URL is unset.');
const live = it.skipIf(serverUrl === undefined);

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await aiWorld('unanswered');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

const launch = async (taskId: string) =>
  await w.world.asPerson(w.p, {
    command: 'task.launch',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(w, taskId),
  });

/** Every launch of the task, oldest first, with its delegation's revocation. */
const launchesOf = async (taskId: string) =>
  await w.world.db.admin.execute<{ id: string; state: string; cause: string | null }>(
    `select l.id, l.state, d.revocation_cause as cause
       from public.task_launches l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.task_id = $1 order by l.launched_at, l.id`,
    [taskId],
  );

/** The launch's start moved back by `minutes`, as if the runner had been away that long. */
const aged = async (taskId: string, minutes: number): Promise<void> => {
  await w.world.db.admin.execute(
    `update public.task_launches set launched_at = launched_at - make_interval(mins => $2)
      where task_id = $1 and state <> 'ended'`,
    [taskId, minutes],
  );
};

const runOn = async (taskId: string) =>
  ((await heldAs(w, w.p, taskId)) as { run: unknown } | null)?.run ?? null;

live('within the bound the run waits, and Launch again is refused while it is open', async () => {
  const task = await launchedTask(w, 'A runner may still come');
  await aged(task, 14);
  expect(await runOn(task)).toMatchObject({ state: 'waiting' });
  expect(codeOf(await launch(task))).toBe('RUN_ALREADY_OPEN');
  expect((await launchesOf(task)).map((one) => one.state)).toStrictEqual(['waiting']);
});

live(
  'past the bound the task says no runner took it, and Launch again opens a fresh run',
  async () => {
    const task = await launchedTask(w, 'No runner answered');
    await aged(task, 16);
    expect(await runOn(task)).toMatchObject({ state: 'unanswered' });

    expect(codeOf(await launch(task))).toBe(APPLIED);

    expect(await launchesOf(task)).toMatchObject([
      { state: 'ended', cause: 'work_retired' },
      { state: 'waiting', cause: null },
    ]);
    expect(await runOn(task)).toMatchObject({ state: 'waiting' });
  },
);

live('a run a runner took is unaffected by the bound', async () => {
  const task = await launchedTask(w, 'The runner took it');
  const [launched] = await launchesOf(task);
  expect(takenAs(await take(w, launched?.id))).toMatchObject({ state: 'started' });
  await aged(task, 60);
  expect(await runOn(task)).toMatchObject({ state: 'started' });
  expect(codeOf(await launch(task))).toBe('RUN_ALREADY_OPEN');
  expect((await launchesOf(task)).map((one) => one.state)).toStrictEqual(['started']);
});

/**
 * How many backends of this database wait on a lock: on the row `pid` holds,
 * or behind the first command, which the second may queue on instead.
 */
const waiters = async (pid: number): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and pid <> $1`,
        [pid],
      )
    )[0]?.n ?? '0',
  );

const pause = async (): Promise<void> => {
  await new Promise<void>((done) => {
    setTimeout(done, 25);
  });
};

/** Polls the server's lock table until `n` backends wait, or gives up. */
const waitFor = async (pid: number, n: number, tries = 0): Promise<void> => {
  if ((await waiters(pid)) >= n) return;
  if (tries > 200) throw new Error(`fewer than ${String(n)} waiters on ${String(pid)}`);
  await pause();
  await waitFor(pid, n, tries + 1);
};

live.each(['take', 'launch'] as const)(
  'a take and a Launch past the bound, %s first in the lock queue, leave one open run',
  async (first) => {
    const task = await launchedTask(w, `Take and Launch race, ${first} first`);
    await aged(task, 16);
    const [launched] = await launchesOf(task);
    const held = await hold(w.world.db, async (execute) => {
      await execute('select 1 from public.records where id = $1 for update', [task]);
    });
    const other = connect(w.world.db.appUrl);
    try {
      const taking = () =>
        executeAgentCommand(
          other,
          w.world.business,
          { provider: 'supabase', subject: w.world.agentSubject() },
          undefined,
          { command: 'task.take_launch', operationId: randomUUID(), launchId: launched?.id },
        );
      const relaunching = () => launch(task);
      const one = first === 'take' ? taking() : relaunching();
      await waitFor(held.pid, 1);
      const two = first === 'take' ? relaunching() : taking();
      await waitFor(held.pid, 2);
      await held.letGo();
      const [a, b] = await Promise.all([one, two]);
      const [taken, relaunched] = first === 'take' ? [a, b] : [b, a];
      const states = (await launchesOf(task)).map((row) => row.state);
      if (first === 'take') {
        expect(takenAs(taken)).toMatchObject({ state: 'started' });
        expect(codeOf(relaunched)).toBe('RUN_ALREADY_OPEN');
        expect(states).toStrictEqual(['started']);
      } else {
        expect(codeOf(relaunched)).toBe(APPLIED);
        expect(takenAs(taken)).not.toMatchObject({ state: 'started' });
        expect(states).toStrictEqual(['ended', 'waiting']);
      }
    } finally {
      await held.letGo();
      await other.close();
    }
  },
);
