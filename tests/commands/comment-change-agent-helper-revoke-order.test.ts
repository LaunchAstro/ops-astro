// SPDX-License-Identifier: AGPL-3.0-only
//
// A helper's comment change on a task that names the helper's delegation as
// its agent, racing `delegation.revoke` of that helper. The revoke writes the
// delegation row, then clears the task's agent, so it waits on the task the
// change holds. The change, once its comment lock is free, must not then wait
// on the delegation row the revoke holds: that closes a cycle PostgreSQL
// breaks by aborting the change (40P01), and its retry is refused although
// it held the task first. Ordered, the change applies and the revoke follows.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connect, connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { aiWorld, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import { insertLogin } from '../identity/fixture.ts';

let w: AiWorld;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) throw new Error('Postgres required');
  w = await aiWorld('comment_helper_revoke_order');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A helper of `writer`'s pickup, holding comment on the task, and its own comment there. */
// oxlint-disable-next-line max-lines-per-function -- one helper, as the round-2 proof makes it
async function helperWithComment() {
  const writer = await w.world.decider(`writer_${randomUUID()}`);
  await w.world.db.app.withBusiness(w.world.business, (tx) =>
    grantTo(tx, writer, 'write', { kind: 'business', id: null }, false, 'run'),
  );
  const picked = await w.world.pickUp(writer, 'A helper revoked while it changes a comment');
  const helperActorId = randomUUID();
  const helper = { provider: 'supabase', subject: `helper_${randomUUID()}` };
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      tx.businessId,
      helperActorId,
    ]);
    const loginId = await insertLogin(tx, helper.subject);
    await tx.query(
      `insert into public.actor_logins
        (business_id, id, login_id, actor_id, linked_by_actor_id) values ($1, $2, $3, $4, $5)`,
      [tx.businessId, randomUUID(), loginId, helperActorId, writer.actorId],
    );
  });
  const handed = await w.world.asAgent(
    {
      command: 'run.delegate_child',
      operationId: randomUUID(),
      leaseId: picked.detail['leaseId'],
      fence: picked.detail['fence'],
      helperActorId,
      purpose: `child_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['comment'],
      expiresInSeconds: 600,
    },
    picked.credential,
  );
  if (isCommandRefusal(handed)) throw new Error(handed.code);
  const credential = handed.detail['credential'];
  const childId = handed.detail['childDelegationId'];
  if (typeof credential !== 'string' || typeof childId !== 'string') {
    throw new TypeError('No child issued');
  }
  const posted = await executeAgentCommand(w.world.db.app, w.world.business, helper, credential, {
    command: 'task.comment',
    operationId: randomUUID(),
    recordId: picked.taskId,
    audience: 'internal',
    body: 'Original words',
  });
  if (isCommandRefusal(posted)) throw new Error(posted.code);
  const commentId = posted.detail['commentId'];
  if (typeof commentId !== 'string') throw new Error('No comment id');
  // The task names the helper's delegation as its agent, as Assign to AI may.
  await w.world.db.admin.execute(
    `update public.records set data = jsonb_set(data, '{agent}', to_jsonb($2::text))
      where id = $1`,
    [picked.taskId, childId],
  );
  return { taskId: picked.taskId, helper, credential, childId, commentId };
}

/** Whether a backend of this world waits on a row lock in a statement matching `like`. */
async function waitsOnLock(like: string, pid?: number): Promise<boolean> {
  const [row] = await w.world.db.admin.execute<{ waiting: boolean }>(
    `select exists(select 1 from pg_stat_activity where datname = $1
       and wait_event_type = 'Lock' and query like $2 and ($3::int is null or pid = $3)) as waiting`,
    [w.world.db.name, like, pid ?? null],
  );
  return row?.waiting === true;
}

it.each(['task.edit_comment', 'task.delete_comment'] as const)(
  '%s by a helper the task names as agent applies before a revoke of that helper that waits on the task',
  // oxlint-disable-next-line max-lines-per-function -- one concurrent schedule
  async (command) => {
    const { taskId, helper, credential, childId, commentId } = await helperWithComment();
    const manager = await enrol(w.world.db.app, w.world.business, `manager_${randomUUID()}`);
    await w.world.db.app.withBusiness(w.world.business, (tx) => grantTo(tx, manager, 'manage'));
    const revoker = connect(w.world.db.appUrl);
    const [revokerBackend] = await revoker.withBusiness(w.world.business, (tx) =>
      tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
    );
    if (revokerBackend === undefined) throw new Error('No revoker backend');
    const server = databaseUrlFromEnvironment();
    if (server === undefined) throw new Error('No database URL');
    const url = new URL(server);
    url.pathname = `/${w.world.db.name}`;
    // Holds the comment's row, so the change waits there with the task held.
    const blocker = connectAsAdmin(url.toString());
    const ready = barrier();
    const release = barrier();
    const held = blocker.transaction(async (execute) => {
      await execute('select 1 from public.records where id = $1 for update', [commentId]);
      ready.resolve();
      await release.promise;
    });
    let changing: ReturnType<typeof executeAgentCommand> | undefined;
    let revoking: ReturnType<typeof executeCommand> | undefined;
    try {
      await ready.promise;
      changing = executeAgentCommand(w.world.db.app, w.world.business, helper, credential, {
        command,
        operationId: randomUUID(),
        recordId: taskId,
        commentId,
        ...(command === 'task.edit_comment' ? { body: 'Changed by the helper' } : {}),
      });
      await expect.poll(() => waitsOnLock('%for update of r%'), { timeout: 10_000 }).toBe(true);
      revoking = executeCommand(revoker, w.world.business, manager.presented, 'api', {
        command: 'delegation.revoke',
        operationId: randomUUID(),
        delegationId: childId,
      });
      // The revoke has written the delegation row and waits on the task.
      await expect.poll(() => waitsOnLock('%', revokerBackend.pid), { timeout: 10_000 }).toBe(true);
      // Past deadlock_timeout (1s): the revoke's one deadlock check has run
      // and found no cycle, so a cycle the change closes aborts the change.
      await sleep(1_500);
      release.resolve();
      await held;
      expect(codeOf(await changing)).toBe('not-a-refusal');
      expect(codeOf(await revoking)).toBe('not-a-refusal');
      const [row] = await w.world.db.admin.execute<{ body: string; deleted: boolean }>(
        `select data ->> 'body' as body, deleted_at is not null as deleted
           from public.records where id = $1`,
        [commentId],
      );
      expect(row).toEqual(
        command === 'task.edit_comment'
          ? { body: 'Changed by the helper', deleted: false }
          : { body: 'Original words', deleted: true },
      );
      const [task] = await w.world.db.admin.execute<{ agent: string | null }>(
        `select data ->> 'agent' as agent from public.records where id = $1`,
        [taskId],
      );
      expect(task?.agent).toBeNull();
    } finally {
      release.resolve();
      await held;
      await Promise.allSettled([changing, revoking]);
      await blocker.close();
      await revoker.close();
    }
  },
  30_000,
);
