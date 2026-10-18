// SPDX-License-Identifier: AGPL-3.0-only
//
// #1886, from Sol round 2 on #1882 (S1882-2), renamed for what it proves and
// otherwise as written. An agent's task update has applied and parks on its own
// actor row in the final standing check while the delegating person's write
// grant is revoked. The update must be refused and write nothing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import { aiWorld, created, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { holdRow, waiterOf, type Held } from '../support/lock-wait-race.ts';
import { serverUrl } from '../acceptance/world.ts';

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('standing_grant_wait');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** A credential for the world's agent, delegated by `p` to read and write one task. */
const credentialOn = async (task: string): Promise<string> =>
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const made = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: w.p.personId,
      mintedByActorId: w.p.actorId,
      purpose: 'standing_grant_wait',
      collections: ['task'],
      actions: ['read', 'write'],
      purposeScope: { kind: 'record', id: task },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!made.ok) throw new Error(made.refusal.code);
    return made.value.credential;
  });

/** The backend parked behind `actor`: the final standing check's `for share` read of it. */
const standingWaiter = async (actor: Held<unknown>): Promise<{ pid: number }> => {
  await waiterOf(w.world.db, actor);
  const [waiter] = await w.world.db.admin.execute<{ pid: number; query: string }>(
    `select pid, query from pg_stat_activity where datname = current_database()
       and wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))`,
    [actor.pid],
  );
  expect(waiter?.query).toContain('public.actors');
  expect(waiter?.query).toContain('for share');
  return waiter!;
};

/** Whether the backend `pid` is now blocking another backend's lock wait. */
const blocksAnother = async (pid: number): Promise<boolean> => {
  const [row] = await w.world.db.admin.execute<{ blocked: boolean }>(
    `select exists(select 1 from pg_stat_activity where datname = current_database()
       and wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))) as blocked`,
    [pid],
  );
  return row?.blocked === true;
};

/** The agent's `task.update` of the task's title, under `credential`. */
const titleChanged = (task: string, revision: number, credential: string) =>
  w.world.asAgent(
    {
      command: 'task.update',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: revision,
      fields: { title: 'changed' },
    },
    credential,
  );

/** The task's stored title. */
const titleOf = async (task: string): Promise<string | undefined> => {
  const [stored] = await w.world.db.admin.execute<{ title: string }>(
    'select txt_4 as title from public.records where id = $1',
    [task],
  );
  return stored?.title;
};

describe.skipIf(serverUrl === undefined)('the final standing check', () => {
  it('refuses an agent task update whose write grant was revoked during its actor lock wait', async () => {
    const task = await created(w, w.p, 'before');
    const revision = await revisionOf(w, task);
    const credential = await credentialOn(task);
    // Compatible with the door's FK key-share lock, incompatible with the
    // final standing check's for-share lock, after the handler's field write.
    const actor = await holdRow(
      w.world.db,
      'select id from public.actors where id = $1 for no key update',
      [w.world.agentActorId],
    );
    const changing = titleChanged(task, revision, credential);
    let revoking: Promise<void> | undefined;
    let revokedBeforeRelease = false;
    try {
      const waiter = await standingWaiter(actor);
      revoking = (async () => {
        await w.world.revokeGrant(w.p.grants.write);
        revokedBeforeRelease = true;
      })();
      // Establish one of two actual orders, without a timing assumption:
      // the old head holds the grant and blocks revoke; the new head lets it commit.
      await expect
        .poll(async () => revokedBeforeRelease || (await blocksAnother(waiter.pid)), {
          timeout: 10_000,
        })
        .toBe(true);
      const committedDuringWait = revokedBeforeRelease;
      await actor.letGo();
      const result = await changing;
      await revoking;
      expect({
        revokedDuringWait: committedDuringWait,
        code: codeOf(result),
        title: await titleOf(task),
      }).not.toEqual({ revokedDuringWait: true, code: 'not-a-refusal', title: 'changed' });
    } finally {
      await actor.letGo();
      await Promise.allSettled([changing, revoking]);
    }
  }, 30_000);
});
