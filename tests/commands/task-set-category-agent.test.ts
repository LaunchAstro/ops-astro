// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 CS-4.16 under a live delegation: an agent labels its own task and no
// other (the third crossing of `MP-4-8 isolation: task category`, beside
// task-set-category), and a category change, by a person or by the agent,
// leaves the agent's grant, its delegation and the task's agent exactly as
// they were (R76, DP-23: the mockup's rewrite of the Agent scope stamp is a
// bug, not copied).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import {
  CANARY,
  aiWorld,
  assign,
  created,
  minted,
  revisionOf,
  type AiWorld,
} from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) {
  console.warn('task-set-category-agent: DATABASE_URL is unset, so nothing ran.');
}

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('cat');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

const categoryOf = async (taskId: string): Promise<unknown> =>
  (
    await w.world.db.admin.execute<{ readonly category: unknown }>(
      `select data -> 'category' as category from public.records where id = $1`,
      [taskId],
    )
  )[0]?.category ?? null;

const byPerson = async (by: Decider, taskId: string, category: unknown) =>
  await w.world.asPerson(by, {
    command: 'task.set_category',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(w, taskId),
    fields: { category },
  });

const byAgent = async (
  credential: string,
  taskId: string,
  fields: Readonly<Record<string, unknown>>,
) =>
  await w.world.asAgent(
    {
      command: 'task.set_category',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(w, taskId),
      fields,
    },
    credential,
  );

/**
 * Everything that says what an agent may touch: every delegation and grant in
 * the business, whole rows, and the task's own fields but its label.
 */
const scopeOf = async (taskId: string, reader: Decider) => {
  const rows = async (sql: string) =>
    (await w.world.db.admin.execute<{ readonly row: unknown }>(sql, [w.world.business])).map(
      (one) => one.row,
    );
  const read = await executeRead(w.world.db.app, w.world.business, reader.presented, {
    read: 'task.read',
    recordId: taskId,
  });
  const task =
    isCommandRefusal(read) || !('task' in read)
      ? null
      : (read.task as unknown as { agent?: unknown; myAgents?: unknown });
  return {
    delegations: await rows(
      `select to_jsonb(d) as row from public.delegations d where business_id = $1 order by id`,
    ),
    grants: await rows(
      `select to_jsonb(g) as row from public.grants g where business_id = $1 order by id`,
    ),
    fields: (
      await w.world.db.admin.execute<{ readonly fields: unknown }>(
        `select (data - 'category') as fields from public.records where id = $1`,
        [taskId],
      )
    )[0]?.fields,
    agent: task?.agent,
    myAgents: task?.myAgents,
  };
};

describe.skipIf(serverUrl === undefined)(
  'MP-4-8 isolation: task category under a live delegation',
  () => {
    it('an agent labels its own delegated task, and no other', async () => {
      const other = await created(w, w.p, CANARY);
      const picked = await w.world.pickUp(w.p, 'the agent’s task');
      const own = await byAgent(picked.credential, picked.taskId, { category: 'content' });
      expect(codeOf(own)).toBe('not-a-refusal');
      expect(await categoryOf(picked.taskId)).toBe('content');
      const foreign = await byAgent(picked.credential, other, { category: 'content' });
      expect(codeOf(foreign)).not.toBe('not-a-refusal');
      expect(JSON.stringify(foreign)).not.toContain(CANARY);
      expect(await categoryOf(other)).toBeNull();
    });

    it('an agent’s label is held to the catalogue, and carries no other field', async () => {
      const picked = await w.world.pickUp(w.p, 'held to the list');
      const off = await byAgent(picked.credential, picked.taskId, { category: 'agent-scope' });
      expect(codeOf(off)).toBe('FIELD_VALUE_INVALID');
      const widened = await byAgent(picked.credential, picked.taskId, {
        category: 'seo',
        agent: randomUUID(),
      });
      expect(codeOf(widened)).toBe('TRANSITION_PROTECTED');
      expect(await categoryOf(picked.taskId)).toBeNull();
    });
  },
);

describe.skipIf(serverUrl === undefined)('MP-4-8 category leaves agent scope', () => {
  it('a person’s category changes leave the agent’s grant, delegation and stamp as they were', async () => {
    const task = await created(w, w.p, 'assigned to AI');
    const agent = await minted(w, w.p, task);
    expect(codeOf(await assign(w, w.p, task, { agent }))).toBe('not-a-refusal');
    const before = await scopeOf(task, w.p);
    expect(before.agent).not.toBeNull();
    for (const category of ['seo', 'dev-integrations', null]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(codeOf(await byPerson(w.p, task, category)), String(category)).toBe('not-a-refusal');
      // oxlint-disable-next-line no-await-in-loop
      expect(await scopeOf(task, w.p), String(category)).toStrictEqual(before);
    }
  });

  it('the agent’s own category change leaves its grant and delegation as they were', async () => {
    const picked = await w.world.pickUp(w.p, 'the agent labels its own');
    const before = await scopeOf(picked.taskId, w.p);
    const answer = await byAgent(picked.credential, picked.taskId, { category: 'reporting' });
    expect(codeOf(answer)).toBe('not-a-refusal');
    expect(await categoryOf(picked.taskId)).toBe('reporting');
    expect(await scopeOf(picked.taskId, w.p)).toStrictEqual(before);
  });
});
