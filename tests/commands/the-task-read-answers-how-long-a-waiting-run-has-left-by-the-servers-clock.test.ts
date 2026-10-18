// SPDX-License-Identifier: AGPL-3.0-only
//
// #1710: the task read answers how long a waiting run's bound has left
// (`boundLeftMs`), worked out in the statement that judges its state, so a
// browser can count down from when the answer arrived with no clock of its
// own set against the server's. A waiting run always has time left; a run
// past its bound (`unanswered`) or taken by a runner has none.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { aiWorld, heldAs, type AiWorld } from './ai-assign-world.ts';
import { launchedTask, launchOf, take, takenAs } from './take-launch-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const live = it.skipIf(serverUrl === undefined);
const BOUND_MS = 15 * 60_000;

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await aiWorld('boundleft');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** The launch's start moved back by `minutes` on the database's own clock. */
const aged = async (taskId: string, minutes: number): Promise<void> => {
  await w.world.db.admin.execute(
    `update public.task_launches set launched_at = launched_at - make_interval(mins => $2)
      where task_id = $1 and state <> 'ended'`,
    [taskId, minutes],
  );
};

const runOn = async (taskId: string) =>
  ((await heldAs(w, w.p, taskId)) as { run: { state: string; boundLeftMs: number } | null } | null)
    ?.run ?? null;

live('a waiting run answers the time its bound has left', async () => {
  const task = await launchedTask(w, 'Ten minutes without a runner');
  await aged(task, 10);
  const run = await runOn(task);
  expect(run?.state).toBe('waiting');
  expect(run?.boundLeftMs).toBeGreaterThan(BOUND_MS / 3 - 60_000);
  expect(run?.boundLeftMs).toBeLessThanOrEqual(BOUND_MS / 3);
});

live('a run past its bound answers unanswered with no time left', async () => {
  const task = await launchedTask(w, 'Sixteen minutes without a runner');
  await aged(task, 16);
  expect(await runOn(task)).toMatchObject({ state: 'unanswered', boundLeftMs: 0 });
});

live('a run a runner took answers no time left', async () => {
  const task = await launchedTask(w, 'Taken at once');
  expect(takenAs(await take(w, (await launchOf(w, task)).id))).toMatchObject({ state: 'started' });
  expect(await runOn(task)).toMatchObject({ state: 'started', boundLeftMs: 0 });
});
