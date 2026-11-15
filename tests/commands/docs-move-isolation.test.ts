// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs piece 4a isolation (#2514, standing gate 9): a folder rename, a folder move and a page move
// never reach another business's folder or page, and never file into one; a docs:write grant held
// at one client reaches none of them; and an agent under a live docs:write delegation never renames
// or moves a folder, and moves a page only on the task it names (#2519,
// docs-agent-moves.test.ts). A canary name never reaches an answer, refusals included.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { detailOf, folderIn, treeOf } from './docs-tree.ts';
import { grantTo } from './fixture.ts';
import { agentWorld, codeOf } from './agent-fixture.ts';
import { WHOLE, timeWorld, type TimeWorld } from './time-world.ts';

const CANARY = `canary-${randomUUID()}`;

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'docs-move-isolation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;
const live = describe.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('dmi');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'write', WHOLE, false, 'docs');
  });
  await w.db.app.withBusiness(w.bravo, async (tx) => {
    await grantTo(tx, w.bravoOwner, 'write', WHOLE, false, 'docs');
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

/** A folder holding one page, in `business`, both named with the canary. */
async function planted(business: typeof w.alpha, member: typeof w.ada) {
  const folderId = await folderIn(w, business, member, `${CANARY}-${randomUUID().slice(0, 8)}`);
  const made = await w.as(business, member, {
    command: 'docs.create_page',
    folderId,
    title: CANARY,
    body: `body ${CANARY}`,
  });
  return { folderId, pageId: String(detailOf(made)['pageId']) };
}

async function pagesIn(business: typeof w.alpha) {
  return await w.db.admin.execute<{ readonly folder_id: string; readonly version: number }>(
    'select folder_id, version from public.docs_pages where business_id = $1 order by id',
    [business],
  );
}

live('docs moves: another business', () => {
  it('another business’s folder is never renamed, moved or moved into, and its page never moved', async () => {
    const theirs = await planted(w.bravo, w.bravoOwner);
    const ours = await planted(w.alpha, w.ada);
    const before = [await treeOf(w, w.bravo), await treeOf(w, w.alpha), await pagesIn(w.bravo)];
    for (const [body, field] of [
      [{ command: 'docs.rename_folder', folderId: theirs.folderId, name: 'renamed' }, 'folderId'],
      [{ command: 'docs.move_folder', folderId: theirs.folderId }, 'folderId'],
      [
        { command: 'docs.move_folder', folderId: ours.folderId, parentId: theirs.folderId },
        'parentId',
      ],
      [
        {
          command: 'docs.update_page',
          pageId: ours.pageId,
          expectedVersion: 1,
          folderId: theirs.folderId,
        },
        'folderId',
      ],
      [
        {
          command: 'docs.update_page',
          pageId: theirs.pageId,
          expectedVersion: 1,
          folderId: ours.folderId,
        },
        'pageId',
      ],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await w.as(w.alpha, w.ada, body);
      expect(codeOf(answer), body.command).toBe('NOT_FOUND');
      expect(isCommandRefusal(answer) ? answer.names : [], body.command).toStrictEqual([field]);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    const after = [await treeOf(w, w.bravo), await treeOf(w, w.alpha), await pagesIn(w.bravo)];
    expect(after).toStrictEqual(before);
  });
});

live('docs moves: another client', () => {
  it('a docs:write grant held at one client renames, moves and moves into nothing', async () => {
    const ours = await planted(w.alpha, w.ada);
    const target = await folderIn(w, w.alpha, w.ada, `target ${randomUUID().slice(0, 8)}`);
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientA, 'write', { kind: 'party', id: randomUUID() }, false, 'docs');
    });
    const before = [await treeOf(w, w.alpha), await pagesIn(w.alpha)];
    for (const body of [
      { command: 'docs.rename_folder', folderId: ours.folderId, name: 'client renamed' },
      { command: 'docs.move_folder', folderId: ours.folderId, parentId: target },
      { command: 'docs.update_page', pageId: ours.pageId, expectedVersion: 1, folderId: target },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await w.as(w.alpha, w.clientA, body);
      expect(codeOf(answer), body.command).toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect([await treeOf(w, w.alpha), await pagesIn(w.alpha)]).toStrictEqual(before);
  });
});

type World = Awaited<ReturnType<typeof agentWorld>>;

/** A delegation carrying docs:write itself, scoped to the agent's task as delegations are. */
async function docsDelegation(
  world: World,
  decider: { personId: string; actorId: string },
  taskId: string,
) {
  return await world.db.app.withBusiness(world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: world.agentActorId,
      delegatePersonId: decider.personId,
      mintedByActorId: decider.actorId,
      purpose: `docs_${randomUUID().replaceAll('-', '')}`,
      collections: ['docs'],
      actions: ['write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`docs delegation refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

it.skipIf(serverUrl === undefined)(
  'an agent under a live docs:write delegation renames and moves no folder, and moves no page without naming its task',
  async () => {
    const world = await agentWorld('dma', `docs-move-agent-${randomUUID().slice(0, 8)}`);
    try {
      const decider = await world.decider('decider');
      await world.db.app.withBusiness(world.business, async (tx) => {
        await grantTo(tx, decider, 'write', WHOLE, false, 'docs');
      });
      const picked = await world.pickUp(decider, 'the agent’s task');
      const as = async (body: Record<string, unknown>) =>
        detailOf(await world.asPerson(decider, { ...body, operationId: randomUUID() }));
      const folderId = String(
        (await as({ command: 'docs.create_folder', name: CANARY }))['folderId'],
      );
      const target = String(
        (await as({ command: 'docs.create_folder', name: 'target' }))['folderId'],
      );
      const made = await as({ command: 'docs.create_page', folderId, title: CANARY, body: CANARY });
      const credential = await docsDelegation(world, decider, picked.taskId);
      for (const body of [
        { command: 'docs.rename_folder', folderId, name: 'agent renamed' },
        { command: 'docs.move_folder', folderId, parentId: target },
        {
          command: 'docs.update_page',
          pageId: made['pageId'],
          expectedVersion: 1,
          folderId: target,
        },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
        const answer = await world.asAgent({ ...body, operationId: randomUUID() }, credential);
        // A folder's rename and move are a person's; a page move asks the task the agent works under.
        expect(codeOf(answer), body.command).toBe(
          body.command === 'docs.update_page'
            ? 'DELEGATION_OUT_OF_PURPOSE'
            : 'DELEGATION_EXCLUDES_OPERATION',
        );
        expect(JSON.stringify(answer)).not.toContain(CANARY);
      }
      const rows = await world.db.admin.execute<{ readonly moved: number }>(
        `select ((select count(*) from public.docs_folders where business_id = $1 and parent_id is not null)
               + (select count(*) from public.docs_page_versions where business_id = $1 and number > 1))::int as moved`,
        [world.business],
      );
      expect(rows[0]?.moved).toBe(0);
    } finally {
      await world.drop();
    }
  },
);
