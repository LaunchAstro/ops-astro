// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs, the agent path (#2519) after #2517's moves: an agent's docs.update_page carrying a
// folderId moves the page, asked exactly as its save is (the director's conditions 1 to 4, round
// events 2026-11-15T10:37:31Z): the delegation must carry docs:write and be on the task the agent
// names, the delegating person's docs:write is asked at business scope, and the version names the
// task and delegation. A folder's rename and move stay a person's (#2514).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { grantTo } from './fixture.ts';
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
  console.warn(
    'docs-agent-moves: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let world: AgentWorld;
let decider: Decider;
let picked: PickedUp;
let credential: string;
let delegationId: string;

const asAgent = async (body: Record<string, unknown>, held = credential) =>
  await world.asAgent({ ...body, operationId: randomUUID() }, held);

const filed = async (body: Record<string, unknown>, field: string) =>
  idOf(await asAgent({ ...body, taskId: picked.taskId }), field);

/** The folder a page sits in now. */
async function folderOf(pageId: string): Promise<string | undefined> {
  const [row] = await world.db.admin.execute<{ folder: string }>(
    `select folder_id::text as folder from public.docs_pages where business_id = $1 and id = $2`,
    [world.business, pageId],
  );
  return row?.folder;
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('dam', `docs-agent-moves-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('decider');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, decider, 'write', WHOLE, false, 'docs');
  });
  picked = await world.pickUp(decider, 'the mover’s task');
  ({ credential, id: delegationId } = await mintDocsDelegation(world, decider, picked.taskId, [
    'docs',
  ]));
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

const live = it.skipIf(serverUrl === undefined);

/** A page the agent filed in `from`, and the folder `to` it may move to. */
async function aPageToMove() {
  const from = await filed(
    { command: 'docs.create_folder', name: `from ${randomUUID()}` },
    'folderId',
  );
  const to = await filed({ command: 'docs.create_folder', name: `to ${randomUUID()}` }, 'folderId');
  const pageId = await filed(
    { command: 'docs.create_page', folderId: from, title: 'Moved', body: 'x' },
    'pageId',
  );
  const move = (taskId: string) => ({
    command: 'docs.update_page',
    pageId,
    expectedVersion: 1,
    folderId: to,
    taskId,
  });
  return { from, to, pageId, move };
}

live(
  '(1-3) an agent’s move is refused on a task-only delegation, a sibling task and a narrow person’s delegation, and the page stays put',
  async () => {
    const { from, pageId, move } = await aPageToMove();
    const before = await docsRowCount(world);
    expect(codeOf(await asAgent(move(picked.taskId), picked.credential))).toBe(
      'DELEGATION_EXCLUDES_OPERATION',
    );
    const sibling = await world.pickUp(decider, 'a sibling of the mover');
    expect(codeOf(await asAgent(move(sibling.taskId)))).toBe('DELEGATION_OUT_OF_PURPOSE');

    const narrow = await world.decider('narrow-mover');
    const task = await world.pickUp(narrow, 'a narrow mover’s task');
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, narrow, 'write', { kind: 'record', id: task.taskId }, false, 'docs');
    });
    const held = await mintDocsDelegation(world, narrow, task.taskId, ['docs'], true);
    expect(codeOf(await asAgent(move(task.taskId), held.credential))).toBe('SCOPE_NOT_GRANTED');

    expect(await folderOf(pageId)).toBe(from);
    expect(await docsRowCount(world)).toBe(before);
  },
);

live(
  '(4) under its own delegation the move is a save: version 2, in the new folder, naming the task and delegation',
  async () => {
    const { to, pageId, move } = await aPageToMove();
    expect(idOf(await asAgent(move(picked.taskId)), 'version')).toBe('2');
    expect(await folderOf(pageId)).toBe(to);
    const pair = { task: picked.taskId, delegation: delegationId };
    expect(await namedOnRows(world, 'docs_page_versions', 'page_id', pageId)).toStrictEqual([
      pair,
      pair,
    ]);
  },
);

live(
  'an agent never renames or moves a folder, even under its docs:write delegation (people only, #2514)',
  async () => {
    const folderId = idOf(
      await world.asPerson(decider, {
        command: 'docs.create_folder',
        name: `person ${randomUUID()}`,
        operationId: randomUUID(),
      }),
      'folderId',
    );
    const parent = await filed(
      { command: 'docs.create_folder', name: `parent ${randomUUID()}` },
      'folderId',
    );
    for (const body of [
      {
        command: 'docs.rename_folder',
        folderId,
        name: 'renamed by an agent',
        taskId: picked.taskId,
      },
      { command: 'docs.move_folder', folderId, parentId: parent, taskId: picked.taskId },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      expect(isCommandRefusal(await asAgent(body)), body.command).toBe(true);
    }
    const [row] = await world.db.admin.execute<{ name: string; parent: string | null }>(
      `select name, parent_id::text as parent from public.docs_folders
        where business_id = $1 and id = $2`,
      [world.business, folderId],
    );
    expect(row?.parent).toBeNull();
    expect(row?.name.startsWith('person ')).toBe(true);
  },
);
