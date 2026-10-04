// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connect, connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import type { AgentRequest } from '../../packages/core-commands/src/commands/agent-call.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { aiWorld, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import { insertLogin } from '../identity/fixture.ts';

let w: AiWorld;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) throw new Error('Postgres required');
  w = await aiWorld('comment_authority_gap');
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

it.each([
  ['task.edit_comment', 'grant.revoke'],
  ['task.delete_comment', 'grant.revoke'],
  ['task.edit_comment', 'child delegation.revoke'],
  ['task.delete_comment', 'child delegation.revoke'],
] as const)(
  'Sol proof, criterion 5: %s cannot apply after %s commits between the final check and write',
  // oxlint-disable-next-line max-lines-per-function -- one concurrent schedule
  async (command, revocation) => {
    const writer = await w.world.decider(`writer_${randomUUID()}`);
    if (revocation === 'child delegation.revoke') {
      await w.world.db.app.withBusiness(w.world.business, (tx) =>
        grantTo(tx, writer, 'write', { kind: 'business', id: null }, false, 'run'),
      );
    }
    const picked = await w.world.pickUp(writer, 'Authority check and write must serialise');
    const helperActorId = randomUUID();
    const helper = { provider: 'supabase', subject: `helper_${randomUUID()}` };
    let credential = picked.credential;
    let childId = '';
    if (revocation === 'child delegation.revoke') {
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await tx.query(
          `insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`,
          [tx.businessId, helperActorId],
        );
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
      const issued = handed.detail['credential'];
      const id = handed.detail['childDelegationId'];
      if (typeof issued !== 'string' || typeof id !== 'string') throw new Error('No child issued');
      credential = issued;
      childId = id;
    }
    const send = (request: AgentRequest) =>
      revocation === 'grant.revoke'
        ? w.world.asAgent(request, credential)
        : executeAgentCommand(w.world.db.app, w.world.business, helper, credential, request);
    const posted = await send({
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: picked.taskId,
      audience: 'internal',
      body: 'Original words',
    });
    if (isCommandRefusal(posted)) throw new Error(posted.code);
    const commentId = posted.detail['commentId'];
    if (typeof commentId !== 'string') throw new Error('No comment id');
    const manager = await enrol(w.world.db.app, w.world.business, `manager_${randomUUID()}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, manager, 'manage');
      await grantTo(tx, manager, 'comment');
    });
    const revoker = connect(w.world.db.appUrl);
    const [revokerBackend] = await revoker.withBusiness(w.world.business, (tx) =>
      tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
    );
    if (revokerBackend === undefined) throw new Error('No revoker backend');

    // This fixture trigger changes no row and no authority decision. It only
    // pauses the final write, modelling a scheduling delay after the check.
    // Its wait is observable on the real PostgreSQL backend.
    await w.world.db.admin.execute(`
      create function public.sol_pause_comment_write() returns trigger language plpgsql as $$
      begin
        if new.id = '${commentId}'::uuid then
          perform pg_advisory_xact_lock(743414);
        end if;
        return new;
      end $$;
      create trigger sol_pause_comment_write before update on public.records
      for each row execute function public.sol_pause_comment_write();
    `);
    const server = databaseUrlFromEnvironment();
    if (server === undefined) throw new Error('No database URL');
    const url = new URL(server);
    url.pathname = `/${w.world.db.name}`;
    const blocker = connectAsAdmin(url.toString());
    const ready = barrier();
    const release = barrier();
    const held = blocker.transaction(async (execute) => {
      await execute('select pg_advisory_xact_lock(743414)');
      ready.resolve();
      await release.promise;
    });
    let changing: ReturnType<typeof w.world.asAgent> | undefined;
    let revoking: ReturnType<typeof executeCommand> | undefined;
    let revokeCommitted = false;
    try {
      await ready.promise;
      changing = send({
        command,
        operationId: randomUUID(),
        recordId: picked.taskId,
        commentId,
        ...(command === 'task.edit_comment' ? { body: 'Changed after revocation' } : {}),
      });
      await expect
        .poll(
          async () => {
            const [row] = await w.world.db.admin.execute<{ waiting: boolean }>(
              `select exists(select 1 from pg_stat_activity where datname = $1
             and wait_event = 'advisory' and query like 'update public.records%') as waiting`,
              [w.world.db.name],
            );
            return row?.waiting;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      revoking = executeCommand(
        revoker,
        w.world.business,
        manager.presented,
        'api',
        revocation === 'grant.revoke'
          ? {
              command: 'grant.revoke',
              operationId: randomUUID(),
              grantId: writer.grants.comment,
            }
          : { command: 'delegation.revoke', operationId: randomUUID(), delegationId: childId },
      ).then((answer) => {
        revokeCommitted = !isCommandRefusal(answer);
        return answer;
      });
      await expect
        .poll(
          async () => {
            if (revokeCommitted) return true;
            const [backend] = await w.world.db.admin.execute<{ waiting: boolean }>(
              `select exists(select 1 from pg_stat_activity where pid = $1
             and wait_event_type = 'Lock') as waiting`,
              [revokerBackend.pid],
            );
            return backend?.waiting;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const revokedBeforeWrite = revokeCommitted;
      const [grant] = await w.world.db.admin.execute<{ revoked: boolean }>(
        revocation === 'grant.revoke'
          ? 'select revoked_at is not null as revoked from public.grants where id = $1'
          : 'select revoked_at is not null as revoked from public.delegations where id = $1',
        [revocation === 'grant.revoke' ? writer.grants.comment : childId],
      );
      expect(grant?.revoked).toBe(revokedBeforeWrite);
      release.resolve();
      await held;
      const changed = await changing;
      expect(codeOf(await revoking)).toBe('not-a-refusal');
      const [row] = await w.world.db.admin.execute<{ body: string; deleted: boolean }>(
        `select data ->> 'body' as body, deleted_at is not null as deleted
           from public.records where id = $1`,
        [commentId],
      );
      if (revokedBeforeWrite)
        expect({ code: codeOf(changed), row }).toEqual({
          code: revocation === 'grant.revoke' ? 'DELEGATION_NARROWED' : 'DELEGATION_NOT_LIVE',
          row: { body: 'Original words', deleted: false },
        });
      else expect(codeOf(changed)).toBe('not-a-refusal');
    } finally {
      release.resolve();
      await held;
      await Promise.allSettled([changing, revoking]);
      await blocker.close();
      await revoker.close();
      await w.world.db.admin.execute(`drop trigger sol_pause_comment_write on public.records;
        drop function public.sol_pause_comment_write();`);
    }
  },
  30_000,
);
