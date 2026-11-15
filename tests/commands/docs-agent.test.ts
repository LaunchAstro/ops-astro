// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs, the agent path (#2519, #2493 piece 3), to the director's five conditions (round events
// 2026-11-15T10:37:31Z): (1) an agent's docs write names the task it works under and is
// authorised on that task by its delegation, and a task with a client is refused
// CLIENT_MODEL_USE_OFF; (2) the delegation must carry docs:write itself; (3) the delegating
// person's docs:write is still asked at business scope by the store; (4) the write names the
// task and the delegation, and its audit event the task; (5) no custody change: the delegation
// stays one task's. A person's write names no task.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, type Member } from './fixture.ts';
import {
  agentWorld,
  codeOf,
  type AgentWorld,
  type Decider,
  type PickedUp,
} from './agent-fixture.ts';
import { WHOLE } from './time-world.ts';
import { docsRowCount, idOf, mintDocsDelegation, namedOnRows } from './docs-agent-support.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) {
  console.warn('docs-agent: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

let world: AgentWorld;
let decider: Decider;
let picked: PickedUp;
let credential: string;
let delegationId: string;
let folderId: string;

const delegation = async (
  person: Member,
  taskId: string,
  collections: readonly string[],
  onTheTask = false,
) => await mintDocsDelegation(world, person, taskId, collections, onTheTask);
const written = async () => await docsRowCount(world);
const namedOn = async (table: 'docs_folders' | 'docs_page_versions', column: string, id: string) =>
  await namedOnRows(world, table, column, id);

const asAgent = async (body: Record<string, unknown>, held = credential) =>
  await world.asAgent({ ...body, operationId: randomUUID() }, held);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('dag', `docs-agent-path-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('decider');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, decider, 'write', WHOLE, false, 'docs');
  });
  picked = await world.pickUp(decider, 'the agent’s task');
  ({ credential, id: delegationId } = await delegation(decider, picked.taskId, ['docs']));
  folderId = idOf(
    await world.asPerson(decider, {
      command: 'docs.create_folder',
      name: `person-${randomUUID().slice(0, 8)}`,
      operationId: randomUUID(),
    }),
    'folderId',
  );
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

const live = it.skipIf(serverUrl === undefined);

/** The subject of each applied Docs audit event the agent's actor left, in chain order. */
async function agentAudit(): Promise<readonly (string | null)[]> {
  const rows = await world.db.admin.execute<{ outcome: string; subject: string | null }>(
    `select outcome, subject_record_id::text as subject from public.audit_events
      where business_id = $1 and command like 'docs.%' and actor_id = $2 order by seq`,
    [world.business, world.agentActorId],
  );
  return rows.map((row) => (row.outcome === 'applied' ? row.subject : `refused ${row.outcome}`));
}

live(
  '(1, 4) an agent under its docs:write delegation files a folder and a page and saves a version, each naming its task and delegation',
  async () => {
    const taskId = picked.taskId;
    const folder = await asAgent({ command: 'docs.create_folder', name: 'Agent notes', taskId });
    const madeFolder = idOf(folder, 'folderId');
    const page = await asAgent({
      command: 'docs.create_page',
      folderId: madeFolder,
      title: 'What I found',
      body: '# Found',
      taskId,
    });
    const pageId = idOf(page, 'pageId');
    const saved = await asAgent({
      command: 'docs.update_page',
      pageId,
      expectedVersion: 1,
      body: '# Found, and checked',
      taskId,
    });
    expect(idOf(saved, 'version')).toBe('2');

    const pair = { task: taskId, delegation: delegationId };
    expect(await namedOn('docs_folders', 'id', madeFolder)).toStrictEqual([pair]);
    expect(await namedOn('docs_page_versions', 'page_id', pageId)).toStrictEqual([pair, pair]);
    expect(await agentAudit()).toStrictEqual(Array.from({ length: 3 }, () => taskId));

    // A person's write names no task: the person continues the agent's page on its version.
    const person = await world.asPerson(decider, {
      command: 'docs.update_page',
      pageId,
      expectedVersion: 2,
      title: 'Read and kept',
      operationId: randomUUID(),
    });
    expect(idOf(person, 'version')).toBe('3');
    const [third] = await world.db.admin.execute<{ task: string | null }>(
      `select task_id::text as task from public.docs_page_versions
      where business_id = $1 and page_id = $2 and number = 3`,
      [world.business, pageId],
    );
    expect(third?.task).toBeNull();
  },
);

live(
  '(2) a delegation that carries task:write and not docs:write is refused DELEGATION_EXCLUDES_OPERATION, and nothing is written',
  async () => {
    const before = await written();
    const taskId = picked.taskId;
    for (const body of [
      { command: 'docs.create_folder', name: 'task only', taskId },
      { command: 'docs.create_page', folderId, title: 'task only', body: '', taskId },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      expect(codeOf(await asAgent(body, picked.credential)), body.command).toBe(
        'DELEGATION_EXCLUDES_OPERATION',
      );
    }
    expect(await written()).toBe(before);
  },
);

live('(1) the task named is the delegation’s own, named at all, and holds no client', async () => {
  const before = await written();
  expect(codeOf(await asAgent({ command: 'docs.create_folder', name: 'no task' }))).toBe(
    'DELEGATION_OUT_OF_PURPOSE',
  );
  const other = await world.pickUp(decider, 'a sibling task');
  expect(
    codeOf(await asAgent({ command: 'docs.create_folder', name: 'x', taskId: other.taskId })),
  ).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(
    codeOf(await asAgent({ command: 'docs.create_folder', name: 'x', taskId: randomUUID() })),
  ).toBe('DELEGATION_OUT_OF_PURPOSE');

  const clientTask = await world.pickUp(decider, 'a client’s task');
  const held = await delegation(decider, clientTask.taskId, ['docs']);
  await world.db.admin.execute(
    `update public.records set uuid_7 = $2::uuid,
          data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [clientTask.taskId, randomUUID()],
  );
  const onClient = await asAgent(
    { command: 'docs.create_page', folderId, title: 'x', body: 'x', taskId: clientTask.taskId },
    held.credential,
  );
  expect(codeOf(onClient)).toBe('CLIENT_MODEL_USE_OFF');
  expect(await written()).toBe(before);
});

live(
  '(3) a person whose docs:write covers only the task, not the business, lends the agent nothing',
  async () => {
    const narrow = await world.decider('narrow');
    const task = await world.pickUp(narrow, 'a narrow person’s task');
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, narrow, 'write', { kind: 'record', id: task.taskId }, false, 'docs');
    });
    const held = await delegation(narrow, task.taskId, ['docs'], true);
    const before = await written();
    const answer = await asAgent(
      { command: 'docs.create_page', folderId, title: 'x', body: 'x', taskId: task.taskId },
      held.credential,
    );
    expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
    expect(await written()).toBe(before);
  },
);

live(
  'a person names no task: a taskId on the person path is refused and nothing is written',
  async () => {
    const before = await written();
    const answer = await world.asPerson(decider, {
      command: 'docs.create_folder',
      name: 'person with a task',
      taskId: picked.taskId,
      operationId: randomUUID(),
    });
    expect(codeOf(answer)).toBe('COMMAND_BODY_INVALID');
    expect(await written()).toBe(before);
  },
);
