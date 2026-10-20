// SPDX-License-Identifier: AGPL-3.0-only
//
// #1886, from Sol round 2 on #1882 (S1882-2) and Sol round 1 on #1890 (S1890-1),
// renamed for what it proves. An agent's task update has applied and parks on its
// own actor row in the final standing check while a manager's `grant.revoke`, on
// its own connection, revokes the delegating person's write grant and commits.
// The update must be refused and write nothing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, mintDelegation, type Database } from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { aiWorld, created, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
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

/** A manager who may revoke `p`'s write grant: it holds the pair itself. */
const aManager = async (): Promise<Member> => {
  const manager = await enrol(w.world.db.app, w.world.business, `manager_${randomUUID()}`);
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, manager, 'manage');
    await grantTo(tx, manager, 'write');
  });
  return manager;
};

/**
 * `manager`'s `grant.revoke` of `p`'s write grant on `revoker`, its own
 * connection: the world's application pool holds one connection, which the
 * parked update has. Whether it applied.
 */
const revokedBy = async (revoker: Database, manager: Member): Promise<boolean> =>
  !isCommandRefusal(
    await executeCommand(revoker, w.world.business, manager.presented, 'api', {
      command: 'grant.revoke',
      operationId: randomUUID(),
      grantId: w.p.grants.write,
    }),
  );

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
    const manager = await aManager();
    // Compatible with the door's FK key-share lock, incompatible with the
    // final standing check's for-share lock, after the handler's field write.
    const actor = await holdRow(
      w.world.db,
      'select id from public.actors where id = $1 for no key update',
      [w.world.agentActorId],
    );
    const changing = titleChanged(task, revision, credential);
    const revoker = connect(w.world.db.appUrl);
    let revoking: Promise<boolean> | undefined;
    try {
      await standingWaiter(actor);
      // The revocation commits while the update is parked: nothing it waits on
      // is held by the update until the final check's chain lock.
      revoking = revokedBy(revoker, manager);
      expect(await revoking).toBe(true);
      await actor.letGo();
      const result = await changing;
      expect({ code: codeOf(result), title: await titleOf(task) }).toEqual({
        code: 'DELEGATION_NARROWED',
        title: 'before',
      });
    } finally {
      await actor.letGo();
      await Promise.allSettled([changing, revoking]);
      await revoker.close();
    }
  }, 30_000);
});
