// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs, the thin slice (#2493 piece 1): a business's folders, its pages as Markdown text and a
// version row for every write, through the envelope against a real database. The crossings
// (another business, another client, another person's agent, a grant revoked in the lock wait)
// are in `docs-isolation.test.ts`.
//
// `docs.create_folder`, `docs.create_page` and `docs.update_page` are `docs:write` on the
// business. `docs:read` joins the grantable keys for the reads that come next.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { grantTo, type Member } from './fixture.ts';
import { WHOLE, outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('docs-commands: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

let w: TimeWorld;
const live = describe.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('dc');
  // Ada and Noah write docs; the task-only member holds no docs key; the client-A member
  // holds `docs:read` only.
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'write', WHOLE, false, 'docs');
    await grantTo(tx, w.noah, 'write', WHOLE, false, 'docs');
    await grantTo(tx, w.clientA, 'read', WHOLE, false, 'docs');
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const run = async (member: Member, body: Record<string, unknown>) =>
  await w.as(w.alpha, member, body);

const detail = (answer: CommandResult): Record<string, unknown> => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return answer.detail as Record<string, unknown>;
};

const folder = async (member: Member, name: string, parentId?: string) =>
  String(
    detail(
      await run(member, {
        command: 'docs.create_folder',
        name,
        ...(parentId === undefined ? {} : { parentId }),
      }),
    )['folderId'],
  );

const page = async (member: Member, folderId: string, title: string, body: string) =>
  String(
    detail(await run(member, { command: 'docs.create_page', folderId, title, body }))['pageId'],
  );

/** The page's version rows, oldest first, as plain objects (the driver's rows carry a prototype). */
async function versions(pageId: string) {
  const rows = await w.db.admin.execute<{
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly actor_id: string;
  }>(
    `select number, title, body, actor_id from public.docs_page_versions
      where page_id = $1 order by number`,
    [pageId],
  );
  return rows.map(({ number, title, body, actor_id }) => ({ number, title, body, actor_id }));
}

async function pageRow(pageId: string) {
  const [row] = await w.db.admin.execute<{
    readonly title: string;
    readonly body: string;
    readonly version: number;
    readonly updated_by_actor_id: string;
  }>(`select title, body, version, updated_by_actor_id from public.docs_pages where id = $1`, [
    pageId,
  ]);
  return row;
}

async function counts() {
  const [row] = await w.db.admin.execute<{
    readonly folders: number;
    readonly pages: number;
    readonly versions: number;
  }>(
    `select (select count(*)::int from public.docs_folders) as folders,
            (select count(*)::int from public.docs_pages) as pages,
            (select count(*)::int from public.docs_page_versions) as versions`,
  );
  return row;
}

live('docs through the commands', () => {
  it('a folder holds folders and pages, and a page starts at version 1 with its first version row', async () => {
    const top = await folder(w.ada, 'Handbook');
    const child = await folder(w.ada, 'Onboarding', top);
    const made = await run(w.ada, {
      command: 'docs.create_page',
      folderId: child,
      title: 'First week',
      body: '# First week\n\nRead the handbook.',
    });
    expect(detail(made)['version']).toBe(1);
    const pageId = String(detail(made)['pageId']);
    const rows = await w.db.admin.execute<{ readonly parent_id: string | null }>(
      `select parent_id from public.docs_folders where id = any($1::uuid[]) order by created_at`,
      [[top, child]],
    );
    expect(rows.map((each) => each.parent_id)).toStrictEqual([null, top]);
    expect(await versions(pageId)).toStrictEqual([
      {
        number: 1,
        title: 'First week',
        body: '# First week\n\nRead the handbook.',
        actor_id: w.ada.actorId,
      },
    ]);
  });
});

live('docs through the commands', () => {
  it('every update appends a version row and keeps the earlier ones', async () => {
    const home = await folder(w.ada, 'Versions');
    const pageId = await page(w.ada, home, 'Draft', 'one');
    const second = await run(w.noah, {
      command: 'docs.update_page',
      pageId,
      expectedVersion: 1,
      body: 'two',
    });
    expect(detail(second)['version']).toBe(2);
    const third = await run(w.ada, {
      command: 'docs.update_page',
      pageId,
      expectedVersion: 2,
      title: 'Final',
    });
    expect(detail(third)['version']).toBe(3);
    expect(
      (await versions(pageId)).map((each) => [each.number, each.title, each.body, each.actor_id]),
    ).toStrictEqual([
      [1, 'Draft', 'one', w.ada.actorId],
      [2, 'Draft', 'two', w.noah.actorId],
      [3, 'Final', 'two', w.ada.actorId],
    ]);
    expect(await pageRow(pageId)).toStrictEqual({
      title: 'Final',
      body: 'two',
      version: 3,
      updated_by_actor_id: w.ada.actorId,
    });
  });
});

live('docs through the commands', () => {
  it('an update against a version the page has moved past is refused VERSION_STALE and writes nothing', async () => {
    const home = await folder(w.ada, 'Stale');
    const pageId = await page(w.ada, home, 'Shared', 'base');
    await run(w.noah, { command: 'docs.update_page', pageId, expectedVersion: 1, body: 'noah' });
    const stale = await run(w.ada, {
      command: 'docs.update_page',
      pageId,
      expectedVersion: 1,
      body: 'ada overwrites',
    });
    expect(outcomeOf(stale)).toStrictEqual({ code: 'VERSION_STALE', names: ['expectedVersion'] });
    expect((await pageRow(pageId))?.body).toBe('noah');
    expect((await versions(pageId)).map((each) => each.body)).toStrictEqual(['base', 'noah']);
  });
});

live('docs through the commands', () => {
  it('a missing folder, parent or page is refused NOT_FOUND on its field and writes nothing', async () => {
    const before = await counts();
    const absent = '00000000-0000-4000-8000-000000000001';
    expect(
      outcomeOf(
        await run(w.ada, { command: 'docs.create_page', folderId: absent, title: 't', body: '' }),
      ),
    ).toStrictEqual({ code: 'NOT_FOUND', names: ['folderId'] });
    expect(
      outcomeOf(await run(w.ada, { command: 'docs.create_folder', name: 'x', parentId: absent })),
    ).toStrictEqual({ code: 'NOT_FOUND', names: ['parentId'] });
    expect(
      outcomeOf(
        await run(w.ada, {
          command: 'docs.update_page',
          pageId: absent,
          expectedVersion: 1,
          body: 'x',
        }),
      ),
    ).toStrictEqual({ code: 'NOT_FOUND', names: ['pageId'] });
    expect(await counts()).toStrictEqual(before);
  });
});

live('docs through the commands', () => {
  it('a folder name is taken once per parent, whatever its case, and free under another', async () => {
    const top = await folder(w.ada, 'Names');
    await folder(w.ada, 'Notes', top);
    expect(
      outcomeOf(await run(w.noah, { command: 'docs.create_folder', name: 'NOTES', parentId: top })),
    ).toStrictEqual({ code: 'UNIQUE_VALUE_TAKEN', names: ['name'] });
    const other = await folder(w.ada, 'Other names');
    expect(await folder(w.ada, 'Notes', other)).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

live('docs through the commands', () => {
  it('a name, title or body out of shape is refused FIELD_VALUE_INVALID on its field', async () => {
    const home = await folder(w.ada, 'Shapes');
    const pageId = await page(w.ada, home, 'Shape', 'ok');
    const cases: [Record<string, unknown>, string][] = [
      [{ command: 'docs.create_folder', name: '  ' }, 'name'],
      [{ command: 'docs.create_folder', name: 'x'.repeat(121) }, 'name'],
      [{ command: 'docs.create_page', folderId: home, title: '', body: '' }, 'title'],
      [{ command: 'docs.create_page', folderId: home, title: 'a\u0007b', body: '' }, 'title'],
      [
        { command: 'docs.create_page', folderId: home, title: 't', body: 'x'.repeat(200_001) },
        'body',
      ],
      [{ command: 'docs.create_page', folderId: home, title: 't', body: 'nul\u0000' }, 'body'],
      [{ command: 'docs.create_page', folderId: home, title: 't', body: 7 }, 'body'],
      [{ command: 'docs.update_page', pageId, expectedVersion: 1 }, 'body'],
      [{ command: 'docs.update_page', pageId, expectedVersion: 0, body: 'x' }, 'expectedVersion'],
      [{ command: 'docs.update_page', pageId, expectedVersion: '1', body: 'x' }, 'expectedVersion'],
    ];
    for (const [body, field] of cases) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = outcomeOf(await run(w.ada, body));
      expect(answer, JSON.stringify(body).slice(0, 80)).toMatchObject({ names: [field] });
      expect(['FIELD_VALUE_INVALID', 'COMMAND_BODY_INVALID']).toContain(
        'code' in answer ? answer.code : 'applied',
      );
    }
    expect((await versions(pageId)).map((each) => each.number)).toStrictEqual([1]);
  });
});

live('docs through the commands', () => {
  it('docs:write refusal: a person without it, or holding only docs:read, is refused SCOPE_NOT_GRANTED and writes nothing', async () => {
    const home = await folder(w.ada, 'Guarded');
    const pageId = await page(w.ada, home, 'Guarded', 'kept');
    const before = await counts();
    for (const member of [w.taskOnly, w.clientA]) {
      for (const body of [
        { command: 'docs.create_folder', name: 'not mine' },
        { command: 'docs.create_page', folderId: home, title: 'not mine', body: '' },
        { command: 'docs.update_page', pageId, expectedVersion: 1, body: 'not mine' },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
        const answer = outcomeOf(await run(member, body));
        expect('code' in answer ? answer.code : 'applied', body.command).toBe('SCOPE_NOT_GRANTED');
      }
    }
    expect(await counts()).toStrictEqual(before);
    expect((await pageRow(pageId))?.body).toBe('kept');
  });
});

live('docs through the commands', () => {
  it('each applied docs write joins the audit chain under its command', async () => {
    const home = await folder(w.ada, 'Audited');
    const pageId = await page(w.ada, home, 'Audited', 'a');
    await run(w.ada, { command: 'docs.update_page', pageId, expectedVersion: 1, body: 'b' });
    const events = await w.db.admin.execute<{ readonly command: string }>(
      `select command from public.audit_events
        where business_id = $1 and actor_id = $2 and outcome = 'applied'
          and command like 'docs.%'`,
      [w.alpha, w.ada.actorId],
    );
    const seen = new Set(events.map((each) => each.command));
    expect([...seen].toSorted()).toStrictEqual([
      'docs.create_folder',
      'docs.create_page',
      'docs.update_page',
    ]);
  });
});
