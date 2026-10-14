// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.take_launch` judges after its last lock, at one instant.
//
// Two takes of one launch, each on a connection of its own, wait on the same
// launch row held elsewhere. Once it is let go, one of them starts the launch
// and the other finds it started by the same agent, so both hand back the one
// derived credential and the launch is taken once.
//
// A revocation in flight holds the delegation row: the take is seen waiting on
// it, and the holder commits the revocation as its last step. The take then
// reads the revoked delegation, ends the launch and hands back no credential.
// The same holds for a delegation whose expiry passes while the take waits.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { blockedBefore, hold, holdRow, type Held, waitPast } from '../support/lock-wait-race.ts';
import { codeOf } from './agent-fixture.ts';
import { aiWorld, type AiWorld } from './ai-assign-world.ts';
import { APPLIED, derivedFor, launchOf, launchedTask, take, takenAs } from './take-launch-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('take races: DATABASE_URL is unset, so nothing ran.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('takerace');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/**
 * Polls until `count` backends wait behind the holder: on it, or on a backend
 * that waits on it, as a second waiter for one row queues behind the first.
 */
async function waitedOnBy(held: Held<unknown>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await w.world.db.admin.execute<{ readonly n: number }>(
      `with recursive behind(pid) as (
         select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))
         union
         select a.pid from pg_stat_activity a, behind b where b.pid = any(pg_blocking_pids(a.pid))
       )
       select count(*)::int as n from behind`,
      [held.pid],
    );
    if ((rows[0]?.n ?? 0) >= count) return;
    // oxlint-disable-next-line no-await-in-loop -- the poll's pause
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`race: fewer than ${count} waiting on the holder`);
}

/** The world agent's take on a connection of its own, so it waits in the database beside the first. */
const takeOn = async (database: Database, launchId: string): Promise<CommandResult> =>
  (await executeAgentCommand(
    database,
    w.world.business,
    { provider: 'supabase', subject: w.world.agentSubject() },
    undefined,
    { command: 'task.take_launch', operationId: randomUUID(), launchId } as never,
  )) as CommandResult;

/** Each case, run only against a database. */
const live = it.skipIf(serverUrl === undefined);

live(
  'two takes of one launch start it once and hand back one credential',
  async () => {
    const task = await launchedTask(w, 'Taken twice at once');
    const launched = await launchOf(w, task);
    const held = await holdRow(
      w.world.db,
      'select 1 from public.task_launches where id = $1 for update',
      [launched.id],
    );
    const second = connect(w.world.db.appUrl);
    let answers;
    try {
      const both = Promise.all([take(w, launched.id), takeOn(second, launched.id)]);
      await waitedOnBy(held, 2);
      await held.letGo();
      answers = await both;
    } finally {
      await held.letGo();
      await second.close();
    }
    const after = await launchOf(w, task);
    const credential = await derivedFor(w, launched.id);

    expect({
      codes: answers.map((answer) => codeOf(answer)),
      credentials: answers.map((answer) => takenAs(answer)['credential']),
      states: answers.map((answer) => takenAs(answer)['state']),
      launch: { state: after.state, takenFor: after.takenFor, taken: after.takenAt !== null },
    }).toStrictEqual({
      codes: [APPLIED, APPLIED],
      credentials: [credential, credential],
      states: ['started', 'started'],
      launch: { state: 'started', takenFor: 'answer', taken: true },
    });
  },
  30_000,
);

live(
  'a revocation committed while the take waits on the delegation ends the launch with no credential',
  async () => {
    const task = await launchedTask(w, 'Revoked while the take waits');
    const launched = await launchOf(w, task);
    const held = await hold(
      w.world.db,
      async (execute) => {
        await execute('select 1 from public.delegations where id = $1 for update', [
          launched.delegationId,
        ]);
      },
      async (execute) => {
        await execute('update public.delegations set revoked_at = now() where id = $1', [
          launched.delegationId,
        ]);
      },
    );
    let answer;
    try {
      const taking = take(w, launched.id);
      await waitedOnBy(held, 1);
      await held.letGo();
      answer = await taking;
    } finally {
      await held.letGo();
    }

    expect({ answer: takenAs(answer), state: (await launchOf(w, task)).state }).toStrictEqual({
      answer: { launchId: launched.id, taskId: task, state: 'ended', cause: 'revoked' },
      state: 'ended',
    });
  },
  30_000,
);

live(
  'a delegation that expires while the take waits on it ends the launch with no credential',
  async () => {
    const task = await launchedTask(w, 'Lapsed while the take waits');
    const launched = await launchOf(w, task);
    const [row] = await w.world.db.admin.execute<{ readonly at: string }>(
      `update public.delegations set expires_at = clock_timestamp() + interval '3 seconds'
      where id = $1 returning expires_at::text as at`,
      [launched.delegationId],
    );
    const expiry = row?.at ?? '';
    const held = await holdRow(
      w.world.db,
      'select 1 from public.delegations where id = $1 for update',
      [launched.delegationId],
    );
    let answer;
    let parkedLive = false;
    try {
      const taking = take(w, launched.id);
      parkedLive = await blockedBefore(w.world.db, held, expiry);
      await waitPast(w.world.db, expiry);
      await held.letGo();
      answer = await taking;
    } finally {
      await held.letGo();
    }

    expect({ parkedLive, answer: takenAs(answer) }).toStrictEqual({
      parkedLive: true,
      answer: { launchId: launched.id, taskId: task, state: 'ended', cause: 'lapsed' },
    });
  },
  30_000,
);
