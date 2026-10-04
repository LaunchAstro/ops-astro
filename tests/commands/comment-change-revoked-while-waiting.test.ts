// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #414, Sol round 1 (PRV-oa-743-R1, criterion 5): an agent's edit or
// delete of its comment that waits on a row lock changes nothing once a
// delegation.revoke or the delegating person's grant.revoke commits. The
// cases are the review's proof, renamed for what they prove and otherwise as
// written.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connect, connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { aiWorld, type AiWorld } from './ai-assign-world.ts';
import { enrol, grantTo } from './fixture.ts';
import { codeOf } from './agent-fixture.ts';

let w: AiWorld;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) throw new Error('This proof requires Postgres.');
  w = await aiWorld('comment_revoke_proof');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

function barrier(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForLock(pid: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const [row] = await w.world.db.admin.execute<{ waiting: boolean }>(
          `select exists(select 1 from pg_stat_activity where datname = $1
         and pid = $2 and wait_event_type = 'Lock') as waiting`,
          [w.world.db.name, pid],
        );
        return row?.waiting;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

it.each([
  ['task.edit_comment', 'delegation.revoke'],
  ['task.delete_comment', 'delegation.revoke'],
  ['task.edit_comment', 'grant.revoke'],
  ['task.delete_comment', 'grant.revoke'],
] as const)(
  'a waiting agent %s changes no comment once %s commits',
  // oxlint-disable-next-line max-lines-per-function -- keep the concurrent schedule in one proof
  async (command, revokeCommand) => {
    const writer = await w.world.decider(`writer_${randomUUID()}`);
    const picked = await w.world.pickUp(writer, 'Revocation while a comment change waits');
    const taskId = picked.taskId;
    const delegationId = picked.detail['delegationId'];
    if (typeof delegationId !== 'string') throw new Error('No delegation id');
    const posted = await w.world.asAgent(
      {
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: taskId,
        audience: 'internal',
        body: 'Kept after revocation',
      },
      picked.credential,
    );
    if (isCommandRefusal(posted)) throw new Error(posted.code);
    const commentId = posted.detail['commentId'];
    if (typeof commentId !== 'string') throw new Error('No comment id');
    const manager = await enrol(w.world.db.app, w.world.business, `manager_${randomUUID()}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, manager, 'manage');
      await grantTo(tx, manager, 'comment');
      await grantTo(tx, manager, 'read');
      await grantTo(tx, manager, 'write');
    });
    const serverUrl = databaseUrlFromEnvironment();
    if (serverUrl === undefined) throw new Error('No server URL');
    const blockerUrl = new URL(serverUrl);
    blockerUrl.pathname = `/${w.world.db.name}`;
    const blocker = connectAsAdmin(blockerUrl.toString());
    const revoker = connect(w.world.db.appUrl);
    const [revokerBackend] = await revoker.withBusiness(w.world.business, (tx) =>
      tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
    );
    const [agentBackend] = await w.world.db.app.withBusiness(w.world.business, (tx) =>
      tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
    );
    if (revokerBackend === undefined || agentBackend === undefined)
      throw new Error('No backend id');
    const ready = barrier();
    const release = barrier();
    // A delegation revocation queues on the task first, before the edit's task
    // lock. A comment-grant revocation needs no task lock, so the edit waits on
    // its comment while that revocation commits. Both are normal public calls.
    const held = blocker.transaction(async (execute) => {
      await execute('select id from public.records where id = $1 for update', [
        revokeCommand === 'delegation.revoke' ? taskId : commentId,
      ]);
      ready.resolve();
      await release.promise;
    });
    let changing: ReturnType<typeof w.world.asAgent> | undefined;
    let revoking: ReturnType<typeof executeCommand> | undefined;
    let revokeCommitted = false;
    const revoke = () =>
      executeCommand(revoker, w.world.business, manager.presented, 'api', {
        command: revokeCommand,
        operationId: randomUUID(),
        ...(revokeCommand === 'delegation.revoke'
          ? { delegationId }
          : { grantId: writer.grants.comment }),
      }).then((answer) => {
        revokeCommitted = !isCommandRefusal(answer);
        return answer;
      });
    const change = () =>
      w.world.asAgent(
        {
          command,
          operationId: randomUUID(),
          recordId: taskId,
          commentId,
          ...(command === 'task.edit_comment' ? { body: 'Changed after revocation' } : {}),
        },
        picked.credential,
      );
    try {
      await ready.promise;
      if (revokeCommand === 'delegation.revoke') {
        revoking = revoke();
        await waitForLock(revokerBackend.pid);
        changing = change();
        await waitForLock(agentBackend.pid);
      } else {
        changing = change();
        await waitForLock(agentBackend.pid);
        revoking = revoke();
        // A corrected implementation may hold the covering grant, keeping
        // revocation waiting until the change commits instead.
        await expect
          .poll(
            async () => {
              if (revokeCommitted) return true;
              const [row] = await w.world.db.admin.execute<{ waiting: boolean }>(
                `select exists(select 1 from pg_stat_activity where pid = $1
               and wait_event_type = 'Lock') as waiting`,
                [revokerBackend.pid],
              );
              return row?.waiting;
            },
            { timeout: 10_000 },
          )
          .toBe(true);
      }
      const revokedWhileBlocked = revokeCommitted;
      release.resolve();
      await held;
      const changed = await changing;
      const revokedFirst =
        revokeCommand === 'delegation.revoke' ? revokeCommitted : revokedWhileBlocked;
      const revoked = await revoking;
      expect(codeOf(revoked)).toBe('not-a-refusal');
      const [row] = await w.world.db.admin.execute<{ body: string; deleted: boolean }>(
        `select data ->> 'body' as body, deleted_at is not null as deleted
           from public.records where id = $1`,
        [commentId],
      );
      if (revokedFirst) {
        expect(
          { code: codeOf(changed), row },
          'The completed revocation must prevent the waiting change',
        ).toEqual({
          code:
            revokeCommand === 'delegation.revoke' ? 'DELEGATION_NOT_LIVE' : 'DELEGATION_NARROWED',
          row: { body: 'Kept after revocation', deleted: false },
        });
      } else {
        expect(codeOf(changed)).toBe('not-a-refusal');
      }
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
