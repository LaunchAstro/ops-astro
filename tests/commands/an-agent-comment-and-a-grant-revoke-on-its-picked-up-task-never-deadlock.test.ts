// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's comment on the task it picked up, and a `grant.revoke` of its
// delegating person's `task:write`, on separate connections. The revocation
// takes the grant row `for update` first and then the work's locks, the task
// among them (it ends the agent's lease and classifies its hold). The comment
// holds the person's covering grants `for share`. If the comment held the task
// first and then asked for the grants, each would wait on the other: a cycle
// Postgres breaks by killing one of them. The schedule is forced, never timed:
// the budget cap the revocation locks before the task is held, so the
// revocation is seen holding its grant and waiting, and the comment is
// started then.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import { holdRow, waiterOf, type Held } from '../support/lock-wait-race.ts';
import { aiWorld, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import { serverUrl } from '../acceptance/world.ts';

/** A database is needed: without one, the file skips. */
const LIVE = it.skipIf(serverUrl === undefined);

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await aiWorld('commentrevokecycle');
}, 180_000);
afterAll(async () => {
  if (serverUrl === undefined) return;
  await w?.world.drop();
});

/** A backend as a `Held`, so the race helpers can ask who waits on it. */
const backend = (pid: number): Held => ({ pid, letGo: async () => await Promise.resolve() });

/** Whether `a` and `b` each wait on the other right now: a deadlock about to be broken. */
async function inCycle(a: number, b: number): Promise<boolean> {
  const [row] = await w.world.db.admin.execute<{ readonly cycle: boolean }>(
    `select ($2::int = any(pg_blocking_pids($1)) and $1::int = any(pg_blocking_pids($2))) as cycle`,
    [a, b],
  );
  return row?.cycle === true;
}

LIVE(
  'an agent comment and a grant revoke on its picked-up task never wait on each other',
  // oxlint-disable-next-line max-lines-per-function -- the pickup, the held cap, both racers and the answer
  async () => {
    const writer = await w.world.decider(`writer_${randomUUID().slice(0, 8)}`);
    const picked = await w.world.pickUp(writer, 'comment and revoke, no cycle');
    const manager = await enrol(
      w.world.db.app,
      w.world.business,
      `mgr_${randomUUID().slice(0, 8)}`,
    );
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      for (const action of ['manage', 'read', 'write', 'comment'] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one grant at a time, one connection
        await grantTo(tx, manager, action);
      }
    });
    const [agentRow] = await w.world.db.app.withBusiness(
      w.world.business,
      async (tx) => await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid'),
    );
    const revoker = connect(w.world.db.appUrl);
    const [revokerRow] = await revoker.withBusiness(
      w.world.business,
      async (tx) => await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid'),
    );
    if (agentRow === undefined || revokerRow === undefined) throw new Error('no backend ids');
    const cap = await holdRow(w.world.db, 'select id from public.budget_caps for update', []);
    let revoking: ReturnType<typeof executeCommand> | undefined;
    let commenting: ReturnType<typeof w.world.asAgent> | undefined;
    let cycle = false;
    try {
      revoking = executeCommand(revoker, w.world.business, manager.presented, 'api', {
        command: 'grant.revoke',
        operationId: randomUUID(),
        grantId: writer.grants.write,
      });
      // The revocation holds the write grant and waits on the cap, before the task.
      await waiterOf(w.world.db, cap);
      commenting = w.world.asAgent(
        {
          command: 'task.comment',
          operationId: randomUUID(),
          recordId: picked.taskId,
          body: 'a comment racing its write grant revoke',
          audience: 'internal',
        },
        picked.credential,
      );
      // The comment reaches the grants and waits on the revocation.
      await waiterOf(w.world.db, backend(revokerRow.pid));
      await cap.letGo();
      const both = Promise.allSettled([revoking, commenting]).then(() => true);
      // oxlint-disable-next-line no-await-in-loop -- polls the two backends until both answer
      while (!cycle && !(await Promise.race([both, delay(5).then(() => false)]))) {
        // oxlint-disable-next-line no-await-in-loop -- polls the two backends until both answer
        cycle = await inCycle(agentRow.pid, revokerRow.pid);
      }
      await both;
    } finally {
      await cap.letGo();
      await Promise.allSettled([revoking, commenting]);
      await revoker.close();
    }
    const revoked = await revoking;
    const commented = await commenting;
    const written = await w.world.commentsOn(picked.taskId);
    expect({
      cycle,
      revoke: codeOf(revoked),
      // The revocation committed before the comment held its grants, so the comment is refused.
      comment: codeOf(commented),
      written,
    }).toEqual({
      cycle: false,
      revoke: 'not-a-refusal',
      comment: 'DELEGATION_NARROWED',
      written: 0,
    });
    expect(isCommandRefusal(revoked)).toBe(false);
  },
  60_000,
);
