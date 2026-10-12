// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's comment or owned field write asks its delegation and the
// delegating person's grant again once the task is locked. A `grant.revoke`
// of that grant takes no task or delegation lock when it costs no live work
// (a comment grant, or a Launch delegation with no lease), so the grant row
// is the only thing the two can meet on. The write holds it `for share`, as
// an agent's comment edit does: the revocation either commits first and the
// write is refused writing nothing, or waits until the write has committed.
// Paused on a second connection just after the authority was asked again.
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
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { gate } from '../support/lock-waits.ts';
import { aiWorld, assign, created, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { enrol, grantTo } from './fixture.ts';
import { codeOf } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('agent_write_grant_hold');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

const WRITTEN = 'Written while its grant was revoked';

/** A launcher holding read, comment, write and assign on `taskId` alone, each a grant of its own. */
async function launcherOn(taskId: string) {
  const launcher = await enrol(w.world.db.app, w.world.business, `launcher_${randomUUID()}`);
  const grants: Record<string, string> = {};
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    for (const action of ['read', 'comment', 'write', 'assign'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction and connection
      const grant = await issueGrant(tx, [], {
        subject: { kind: 'person', id: launcher.personId },
        scope: { kind: 'record', id: taskId },
        collection: 'task',
        action,
        parentGrantId: null,
        grantedByActorId: launcher.actorId,
      });
      if (!grant.ok) throw new Error(grant.refusal.code);
      grants[action] = grant.value;
    }
    await grantTo(tx, w.p, 'manage');
  });
  return { launcher, grants };
}

/** A task launched to the world's agent by a launcher holding record grants on it alone. */
async function launched() {
  const taskId = await created(w, w.p, 'An agent write racing a grant revocation');
  const { launcher, grants } = await launcherOn(taskId);
  await w.world.db.admin.execute('update public.actors set owner_person_id = $1 where id = $2', [
    launcher.personId,
    w.world.agentActorId,
  ]);
  expect(codeOf(await assign(w, launcher as never, taskId, { agent: w.world.agentActorId }))).toBe(
    'not-a-refusal',
  );
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
  if (!keys.ok || delegation === undefined) throw new Error('no launch');
  const credential = keys.keys.derive(delegation.key, {
    businessId: w.world.business,
    agentActorId: w.world.agentActorId,
    delegationId: delegation.id,
  });
  if (credential === undefined) throw new Error('no credential');
  return { taskId, credential, grants };
}

/** How many records carry the agent's text, in a body or a title. */
const writtenOn = async (): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ n: number }>(
        `select count(*)::int as n from public.records
          where business_id = $1 and (data ->> 'body' = $2 or data ->> 'title' = $2)`,
        [w.world.business, WRITTEN],
      )
    )[0]?.n,
  );

/**
 * The agent's database, paused once its authority has been asked again under
 * the task lock: after `askedAgain` holds the delegation and reads the grants.
 */
function pausedAfterAskedAgain(database: Database) {
  const reached = gate();
  const resume = gate();
  let pid = 0;
  let sawHold = false;
  const paused: Database = {
    log: database.log,
    close: async () => await database.close(),
    withBusiness: async (businessId, run) =>
      await database.withBusiness(businessId, async (tx) => {
        const [backend] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
        pid = backend?.pid ?? 0;
        const wrapped: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: async (work) => await tx.savepoint(work),
          query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
            const rows = await tx.query<Row>(sql, parameters);
            if (sql.includes('from public.delegations') && sql.includes('for share')) {
              sawHold = true;
            } else if (sawHold && sql.includes('with recursive effective')) {
              sawHold = false;
              reached.release();
              await resume.promise;
            }
            return rows;
          },
        };
        return await run(wrapped);
      }),
  };
  return { paused, reached: reached.promise, resume: resume.release, pid: () => pid };
}

it.skipIf(serverUrl === undefined).each([
  ['task.comment', 'comment'],
  ['task.update', 'write'],
] as const)(
  'an agent %s holds the %s grant it was asked again on: a revocation waits for it or refuses it',
  // oxlint-disable-next-line max-lines-per-function -- one observed concurrent schedule
  async (command, action) => {
    const { taskId, credential, grants } = await launched();
    const before = await writtenOn();
    const writerDb = connect(w.world.db.appUrl);
    const revokerDb = connect(w.world.db.appUrl);
    const agent = pausedAfterAskedAgain(writerDb);
    const [revoker] = await revokerDb.withBusiness(w.world.business, (tx) =>
      tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
    );
    let writing: Promise<unknown> | undefined;
    let revoking: ReturnType<typeof executeCommand> | undefined;
    let revokeCommitted = false;
    try {
      writing = executeAgentCommand(
        agent.paused,
        w.world.business,
        { provider: 'supabase', subject: w.world.agentSubject() },
        credential,
        command === 'task.comment'
          ? {
              command,
              operationId: randomUUID(),
              recordId: taskId,
              audience: 'internal',
              body: WRITTEN,
            }
          : {
              command,
              operationId: randomUUID(),
              recordId: taskId,
              expectedRevision: await revisionOf(w, taskId),
              fields: { title: WRITTEN },
            },
      );
      await agent.reached;
      revoking = executeCommand(revokerDb, w.world.business, w.p.presented, 'api', {
        command: 'grant.revoke',
        operationId: randomUUID(),
        grantId: grants[action],
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
              [agent.pid(), revoker?.pid],
            );
            return row?.blocked;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const revokedBeforeWrite = revokeCommitted;
      agent.resume();
      const wrote = await writing;
      expect(codeOf(await revoking)).toBe('not-a-refusal');
      const outcome = {
        code: codeOf(wrote as CommandResult),
        written: (await writtenOn()) - before,
      };
      expect(
        { revokedBeforeWrite, ...outcome },
        'a revocation that committed while the write held its asked-again authority',
      ).toEqual({ revokedBeforeWrite: false, code: 'not-a-refusal', written: 1 });
    } finally {
      agent.resume();
      await Promise.allSettled([writing, revoking]);
      await writerDb.close();
      await revokerDb.close();
    }
  },
  30_000,
);
