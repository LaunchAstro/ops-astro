// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's comment edit or delete under a Launch delegation holds the grant
// that admits it, on the launcher's person or on the actor the Launch was
// minted on, so a revocation of that grant waits for the change, or commits
// first and the change is refused writing nothing. Body kept as written for
// the PR's review.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  configuredCredentialKeys,
  connect,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/index.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { aiWorld, assign, created, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { enrol, grantTo } from './fixture.ts';
import { codeOf } from './agent-fixture.ts';

let w: AiWorld;
beforeAll(async () => {
  w = await aiWorld('sol_actor_race');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

function barrier() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

it.each([
  ['task.edit_comment', 'actor'],
  ['task.delete_comment', 'actor'],
  ['task.edit_comment', 'person'],
  ['task.delete_comment', 'person'],
] as const)(
  '%s holds the %s grant that admits a Launch comment change',
  // oxlint-disable-next-line max-lines-per-function -- keep the observed concurrent schedule in one proof
  async (command, holder) => {
    const taskId = await created(w, w.p, 'Actor authority during comment change');
    const launcher = await enrol(w.world.db.app, w.world.business, `launcher_${randomUUID()}`);
    let commentGrant = '';
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      for (const action of ['read', 'comment', 'write', 'assign'] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one transaction and connection
        const grant = await issueGrant(tx, [], {
          subject: { kind: holder, id: holder === 'actor' ? launcher.actorId : launcher.personId },
          scope: { kind: 'record', id: taskId },
          collection: 'task',
          action,
          parentGrantId: null,
          grantedByActorId: launcher.actorId,
        });
        if (!grant.ok) throw new Error(grant.refusal.code);
        if (action === 'comment') commentGrant = grant.value;
      }
      await grantTo(tx, w.p, 'manage');
    });
    await w.world.db.admin.execute('update public.actors set owner_person_id = $1 where id = $2', [
      launcher.personId,
      w.world.agentActorId,
    ]);
    expect(
      codeOf(await assign(w, launcher as never, taskId, { agent: w.world.agentActorId })),
    ).toBe('not-a-refusal');
    expect(
      codeOf(
        await w.world.asPerson(launcher, {
          command: 'task.launch',
          operationId: randomUUID(),
          recordId: taskId,
          expectedRevision: await revisionOf(w, taskId),
        }),
      ),
    ).toBe('not-a-refusal');
    const [delegation] = await w.world.db.admin.execute<{ id: string; key: string }>(
      `select d.id, d.credential_key_id as key from public.task_launches l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
       where l.task_id = $1 and l.state = 'waiting'`,
      [taskId],
    );
    const keys = configuredCredentialKeys();
    if (!keys.ok || delegation === undefined) throw new Error('No launch');
    const credential = keys.keys.derive(delegation.key, {
      businessId: w.world.business,
      agentActorId: w.world.agentActorId,
      delegationId: delegation.id,
    });
    if (credential === undefined) throw new Error('No key');
    const posted = await w.world.asAgent(
      {
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: taskId,
        audience: 'internal',
        body: 'Original words',
      },
      credential,
    );
    if (isCommandRefusal(posted)) throw new Error(posted.code);
    const commentId = posted.detail['commentId'];
    if (typeof commentId !== 'string') throw new Error('No comment id');

    const reached = barrier();
    const resume = barrier();
    const changingDb = connect(w.world.db.appUrl);
    const revokerDb = connect(w.world.db.appUrl);
    let changePid = 0;
    let revokePid = 0;
    await revokerDb.withBusiness(w.world.business, async (tx) => {
      const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      revokePid = row?.pid ?? 0;
    });
    const intercepted: Database = {
      log: changingDb.log,
      close: async () => await changingDb.close(),
      withBusiness: async (businessId, run) =>
        await changingDb.withBusiness(businessId, async (tx) => {
          const [backend] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          changePid = backend?.pid ?? 0;
          const wrapped: TransactionQuery = {
            businessId: tx.businessId,
            savepoint: async (work) => await tx.savepoint(work),
            query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
              // Stop after ownComment's final delegation/grant recheck, immediately before the write.
              if (parameters?.[2] === commentId && sql.includes('update public.records')) {
                reached.release();
                await resume.held;
              }
              return await tx.query<Row>(sql, parameters);
            },
          };
          return await run(wrapped);
        }),
    };
    let changing: ReturnType<typeof executeAgentCommand> | undefined;
    let revoking: ReturnType<typeof executeCommand> | undefined;
    let revokeCommitted = false;
    try {
      changing = executeAgentCommand(
        intercepted,
        w.world.business,
        { provider: 'supabase', subject: w.world.agentSubject() },
        credential,
        {
          command,
          operationId: randomUUID(),
          recordId: taskId,
          commentId,
          ...(command === 'task.edit_comment' ? { body: 'Changed after revocation' } : {}),
        },
      );
      await reached.held;
      revoking = executeCommand(revokerDb, w.world.business, w.p.presented, 'api', {
        command: 'grant.revoke',
        operationId: randomUUID(),
        grantId: commentGrant,
      }).then((result) => {
        revokeCommitted = !isCommandRefusal(result);
        return result;
      });
      await expect
        .poll(
          async () => {
            if (revokeCommitted) return true;
            const [row] = await w.world.db.admin.execute<{ blocked: boolean }>(
              'select $1::int = any(pg_blocking_pids($2)) as blocked',
              [changePid, revokePid],
            );
            return row?.blocked;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const revokedBeforeWrite = revokeCommitted;
      resume.release();
      const changed = await changing;
      expect(codeOf(await revoking)).toBe('not-a-refusal');
      const [row] = await w.world.db.admin.execute<{ body: string; deleted: boolean }>(
        `select data ->> 'body' as body, deleted_at is not null as deleted
           from public.records where id = $1`,
        [commentId],
      );
      if (revokedBeforeWrite) {
        expect(
          { code: codeOf(changed), row },
          'A completed revocation must prevent the subsequent comment write',
        ).toEqual({
          code: 'DELEGATION_NARROWED',
          row: { body: 'Original words', deleted: false },
        });
      } else {
        expect(codeOf(changed)).toBe('not-a-refusal');
      }
    } finally {
      resume.release();
      await Promise.allSettled([changing, revoking]);
      await changingDb.close();
      await revokerDb.close();
    }
  },
  30_000,
);
