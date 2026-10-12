// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's comment or owned field write takes the task's row, asks its
// authority again, then writes, in one transaction. A connection that dies at
// any of those steps (after the task is locked, after the authority is asked
// again, or after the write and before the commit) leaves nothing: no record
// carries the write and the operation is not spent. The agent's retry with the
// same operation id then applies once, and a retry after a lost answer gets
// the same answer and writes nothing more.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  connect,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/index.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { aiWorld, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('agent_write_dies');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

type Step =
  | 'after the task lock'
  | 'after the authority is asked again'
  | 'after the write, before the commit';

/** How many records carry `text`, in a body or a title. */
const carrying = async (text: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ n: number }>(
        `select count(*)::int as n from public.records
          where business_id = $1 and (data ->> 'body' = $2 or data ->> 'title' = $2)`,
        [w.world.business, text],
      )
    )[0]?.n,
  );

/** A database whose transaction dies at `step`, once. */
function dyingAt(database: Database, step: Step): Database {
  let died = false;
  const die = (): never => {
    died = true;
    throw new Error(`the connection died: ${step}`);
  };
  return {
    log: database.log,
    close: async () => await database.close(),
    withBusiness: async (businessId, run) =>
      await database.withBusiness(businessId, async (tx) => {
        let held = false;
        const wrapped: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: async (work) => await tx.savepoint(work),
          query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
            const rows = await tx.query<Row>(sql, parameters);
            if (died) return rows;
            const locked = sql.includes('trash_batch_id') && sql.includes('for update');
            if (step === 'after the task lock' && locked) die();
            if (sql.includes('from public.delegations') && sql.includes('for share')) held = true;
            if (
              step === 'after the authority is asked again' &&
              held &&
              sql.includes('with recursive effective')
            )
              die();
            return rows;
          },
        };
        const result = await run(wrapped);
        if (step === 'after the write, before the commit' && !died && held) die();
        return result;
      }),
  };
}

const STEPS: readonly Step[] = [
  'after the task lock',
  'after the authority is asked again',
  'after the write, before the commit',
];

it
  .skipIf(serverUrl === undefined)
  .each(
    (['task.comment', 'task.update'] as const).flatMap((command) =>
      STEPS.map((step) => [command, step] as const),
    ),
  )(
  'an agent %s whose connection dies %s writes nothing, and its retry applies once',
  async (command, step) => {
    const writer = await w.world.decider(`writer_${randomUUID()}`);
    const picked = await w.world.pickUp(writer, `An agent write that dies: ${step}`);
    const text = `Written once after dying: ${randomUUID()}`;
    const body =
      command === 'task.comment'
        ? {
            command,
            operationId: randomUUID(),
            recordId: picked.taskId,
            audience: 'internal',
            body: text,
          }
        : {
            command,
            operationId: randomUUID(),
            recordId: picked.taskId,
            expectedRevision: await revisionOf(w, picked.taskId),
            fields: { title: text },
          };
    const own = connect(w.world.db.appUrl);
    try {
      const died = await executeAgentCommand(
        dyingAt(own, step),
        w.world.business,
        { provider: 'supabase', subject: w.world.agentSubject() },
        picked.credential,
        body as never,
      ).then(() => 'answered', String);
      expect(died).toContain('the connection died');
      expect(await carrying(text)).toBe(0);
    } finally {
      await own.close();
    }

    const first = await w.world.asAgent(body, picked.credential);
    expect(codeOf(first)).toBe('not-a-refusal');
    expect(await carrying(text)).toBe(1);
    const lostAnswer = await w.world.asAgent(body, picked.credential);
    expect(lostAnswer).toStrictEqual(first as CommandResult);
    expect(await carrying(text)).toBe(1);
  },
  30_000,
);
