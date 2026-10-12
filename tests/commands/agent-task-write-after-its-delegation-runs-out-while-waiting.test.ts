// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's comment or field write on its own task is authorised before it
// waits for the task's row. When its delegation runs out while the write
// waits, the write applies nothing: the delegation and the delegating
// person's grant are asked again once the task is locked, as an agent's
// comment edit already does.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { aiWorld, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('agent_write_revoke');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

async function parked(pid: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const [row] = await w.world.db.admin.execute<{ waiting: boolean }>(
          `select exists(select 1 from pg_stat_activity where pid = $1
             and wait_event_type = 'Lock') as waiting`,
          [pid],
        );
        return row?.waiting;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

const backendOf = async (database: AiWorld['world']['db']['app']): Promise<number> => {
  const [row] = await database.withBusiness(w.world.business, (tx) =>
    tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
  );
  if (row === undefined) throw new Error('no backend');
  return row.pid;
};

const WRITTEN = 'Written after revocation';

/** The task's revision, and how many records carry the waiting write's text. */
const stateOf = async (taskId: string) =>
  (
    await w.world.db.admin.execute<{ revision: number; written: number }>(
      `select r.revision, (select count(*)::int from public.records c
                            where c.business_id = r.business_id and c.data ->> 'body' = $2)
                          as written
         from public.records r where r.id = $1`,
      [taskId, WRITTEN],
    )
  )[0];

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The task's row held on a connection of its own until `release` opens. */
async function holdTask(taskId: string, release: Promise<void>) {
  const blockerUrl = new URL(serverUrl ?? '');
  blockerUrl.pathname = `/${w.world.db.name}`;
  const blocker = connectAsAdmin(blockerUrl.toString());
  const locked = gate();
  const held = blocker
    .transaction(async (execute) => {
      await execute('select id from public.records where id = $1 for update', [taskId]);
      locked.open();
      await release;
    })
    .finally(async () => await blocker.close());
  await locked.promise;
  // Wrapped, so awaiting the hold does not wait for its release.
  return { held };
}

it.skipIf(serverUrl === undefined).each(['task.comment', 'task.update'] as const)(
  'an agent %s waiting on its task applies nothing once its delegation runs out',
  async (command) => {
    const writer = await w.world.decider(`writer_${randomUUID()}`);
    const picked = await w.world.pickUp(writer, 'A delegation that runs out while a write waits');
    const { taskId } = picked;
    const before = await stateOf(taskId);
    const release = gate();
    const { held } = await holdTask(taskId, release.promise);
    try {
      // Live when the write is authorised, gone by the time the task is free.
      await w.world.db.admin.execute(
        `update public.delegations set expires_at = clock_timestamp() + interval '2 seconds'
          where id = $1`,
        [picked.detail['delegationId']],
      );
      const agentPid = await backendOf(w.world.db.app);
      const writing = w.world.asAgent(
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
              expectedRevision: Number(before?.revision),
              fields: { title: WRITTEN },
            },
        picked.credential,
      );
      await parked(agentPid);
      await sleep(2_500);
      release.open();
      expect(codeOf(await writing)).toBe('DELEGATION_NOT_LIVE');
      expect(await stateOf(taskId)).toEqual(before);
    } finally {
      release.open();
      await held;
    }
  },
  30_000,
);
