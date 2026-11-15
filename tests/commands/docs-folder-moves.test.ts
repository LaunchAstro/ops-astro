// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs piece 4a (#2514): a folder renamed or moved, and a page moved between folders, through the
// envelope against a real database. A folder never lands under itself or one of its own
// subfolders; a page move is a save that names its version. The races (crossing moves, a rename
// against a create) are in `docs-folder-move-races.test.ts`, and the crossings (another business,
// another client, an agent) in `docs-move-isolation.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOrApplied, detailOf, folderIn, treeOf } from './docs-tree.ts';
import { grantTo, type Member } from './fixture.ts';
import { WHOLE, outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'docs-folder-moves: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;
const live = describe.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('dfm');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'write', WHOLE, false, 'docs');
    await grantTo(tx, w.clientA, 'read', WHOLE, false, 'docs');
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const run = async (body: Record<string, unknown>, member: Member = w.ada) =>
  await w.as(w.alpha, member, body);
const detail = detailOf;
const folder = async (name: string, parentId?: string) =>
  await folderIn(w, w.alpha, w.ada, name, parentId);
const tree = async () => await treeOf(w, w.alpha);

live('docs folders renamed and moved', () => {
  it('a folder is renamed in place, its subfolders and pages kept, and a name its parent holds in any case is refused UNIQUE_VALUE_TAKEN', async () => {
    const top = await folder('Rename root');
    const child = await folder('Draft name', top);
    await folder('Taken', top);
    const grandchild = await folder('Inside', child);
    expect(
      detail(await run({ command: 'docs.rename_folder', folderId: child, name: 'Final name' })),
    ).toStrictEqual({ folderId: child });
    expect((await tree())[child]).toStrictEqual([top, 'Final name']);
    expect((await tree())[grandchild]).toStrictEqual([child, 'Inside']);
    const taken = await run({ command: 'docs.rename_folder', folderId: child, name: 'TAKEN' });
    expect(outcomeOf(taken)).toStrictEqual({ code: 'UNIQUE_VALUE_TAKEN', names: ['name'] });
    const blank = await run({ command: 'docs.rename_folder', folderId: child, name: '  ' });
    expect(outcomeOf(blank)).toMatchObject({ names: ['name'] });
    expect((await tree())[child]).toStrictEqual([top, 'Final name']);
  });
});

live('docs folders renamed and moved', () => {
  it('a folder moves under another folder and back to the top, its subfolders with it', async () => {
    const from = await folder('Move from');
    const to = await folder('Move to');
    const moving = await folder('Moving', from);
    const inner = await folder('Inner', moving);
    expect(
      detail(await run({ command: 'docs.move_folder', folderId: moving, parentId: to })),
    ).toStrictEqual({ folderId: moving });
    expect((await tree())[moving]).toStrictEqual([to, 'Moving']);
    expect((await tree())[inner]).toStrictEqual([moving, 'Inner']);
    expect(codeOrApplied(await run({ command: 'docs.move_folder', folderId: moving }))).toBe(
      'applied',
    );
    expect((await tree())[moving]).toStrictEqual([null, 'Moving']);
  });
});

live('docs folders renamed and moved', () => {
  it('a move under the folder itself or one of its own subfolders is refused FIELD_VALUE_INVALID on parentId, and the tree is unchanged', async () => {
    const top = await folder('Cycle top');
    const middle = await folder('Cycle middle', top);
    const bottom = await folder('Cycle bottom', middle);
    const before = await tree();
    for (const parentId of [top, middle, bottom]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await run({ command: 'docs.move_folder', folderId: top, parentId });
      expect(outcomeOf(answer), parentId).toStrictEqual({
        code: 'FIELD_VALUE_INVALID',
        names: ['parentId'],
      });
    }
    expect(await tree()).toStrictEqual(before);
  });
});

live('docs folders renamed and moved', () => {
  it('a move into a folder that holds that name already is refused UNIQUE_VALUE_TAKEN, and a missing folder or parent NOT_FOUND', async () => {
    const left = await folder('Left');
    const right = await folder('Right');
    const notes = await folder('Notes', left);
    await folder('NOTES', right);
    const absent = '00000000-0000-4000-8000-000000000002';
    expect(
      outcomeOf(await run({ command: 'docs.move_folder', folderId: notes, parentId: right })),
    ).toStrictEqual({ code: 'UNIQUE_VALUE_TAKEN', names: ['name'] });
    expect(
      outcomeOf(await run({ command: 'docs.move_folder', folderId: notes, parentId: absent })),
    ).toStrictEqual({ code: 'NOT_FOUND', names: ['parentId'] });
    expect(
      outcomeOf(await run({ command: 'docs.move_folder', folderId: absent, parentId: right })),
    ).toStrictEqual({ code: 'NOT_FOUND', names: ['folderId'] });
    expect(
      outcomeOf(await run({ command: 'docs.rename_folder', folderId: absent, name: 'x' })),
    ).toStrictEqual({ code: 'NOT_FOUND', names: ['folderId'] });
    expect((await tree())[notes]).toStrictEqual([left, 'Notes']);
  });
});

live('docs folders renamed and moved', () => {
  it('docs:write refusal: a person without it, or holding only docs:read, cannot rename or move a folder', async () => {
    const own = await folder('Guarded folder');
    const other = await folder('Guarded target');
    const before = await tree();
    for (const member of [w.taskOnly, w.clientA]) {
      for (const body of [
        { command: 'docs.rename_folder', folderId: own, name: 'not mine' },
        { command: 'docs.move_folder', folderId: own, parentId: other },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
        expect(codeOrApplied(await run(body, member)), body.command).toBe('SCOPE_NOT_GRANTED');
      }
    }
    expect(await tree()).toStrictEqual(before);
  });
});

live('docs pages moved', () => {
  it('a page moves to another folder as a save: it names its version, appends a version row, and a stale move is refused VERSION_STALE', async () => {
    const from = await folder('Page from');
    const to = await folder('Page to');
    const made = detail(
      await run({
        command: 'docs.create_page',
        folderId: from,
        title: 'Moving page',
        body: 'kept',
      }),
    );
    const pageId = String(made['pageId']);
    const move = async (expectedVersion: number, folderId: string) =>
      await run({ command: 'docs.update_page', pageId, expectedVersion, folderId });
    expect(detail(await move(1, to))['version']).toBe(2);
    expect(outcomeOf(await move(1, from))).toStrictEqual({
      code: 'VERSION_STALE',
      names: ['expectedVersion'],
    });
    const absent = '00000000-0000-4000-8000-000000000003';
    expect(outcomeOf(await move(2, absent))).toStrictEqual({
      code: 'NOT_FOUND',
      names: ['folderId'],
    });
    const [row] = await w.db.admin.execute<{
      readonly folder_id: string;
      readonly version: number;
    }>('select folder_id, version from public.docs_pages where id = $1', [pageId]);
    expect({ ...row }).toStrictEqual({ folder_id: to, version: 2 });
    const versions = await w.db.admin.execute<{ readonly number: number; readonly body: string }>(
      'select number, body from public.docs_page_versions where page_id = $1 order by number',
      [pageId],
    );
    expect(versions.map(({ number, body }) => [number, body])).toStrictEqual([
      [1, 'kept'],
      [2, 'kept'],
    ]);
  });
});

live('docs pages moved', () => {
  it('each applied rename and move joins the audit chain under its command', async () => {
    const one = await folder('Audit one');
    const two = await folder('Audit two');
    await run({ command: 'docs.rename_folder', folderId: one, name: 'Audit one renamed' });
    await run({ command: 'docs.move_folder', folderId: one, parentId: two });
    const events = await w.db.admin.execute<{ readonly command: string }>(
      `select distinct command from public.audit_events
        where business_id = $1 and outcome = 'applied' and command in ('docs.rename_folder', 'docs.move_folder')`,
      [w.alpha],
    );
    expect(events.map((each) => each.command).toSorted()).toStrictEqual([
      'docs.move_folder',
      'docs.rename_folder',
    ]);
  });
});
