// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs piece 4b (#2515, round DECISIONS 129): Edit, New, Rename and Move on the Docs screen.
// Edit opens the page's Markdown in a plain textarea with the rendered preview beside it; Save
// sends docs.update_page with the version the page was opened at, and a page that moved on is
// the plain "This page changed since you opened it" with the draft kept. One operation id per
// intent, reused on a retry; a business switch drops the draft. The controls show only with
// docs:write; the server still asks it on every write.

import { afterEach, expect, it, vi } from 'vitest';
import { open, json, session, settle } from './mp-2-1-support.tsx';

afterEach(() => {
  vi.restoreAllMocks();
});

const TREE = {
  ok: true,
  folders: [
    { id: 'f-top', name: 'Handbook', parentId: null },
    { id: 'f-other', name: 'Policies', parentId: null },
  ],
  pages: [{ id: 'p-one', folderId: 'f-top', title: 'First week', version: 2 }],
};

const PAGE = {
  ok: true,
  document: {
    id: 'p-one',
    folderId: 'f-top',
    title: 'First week',
    body: '# Welcome',
    version: 2,
    updatedAt: '2026-11-15T00:00:00.000Z',
  },
};

const capabilities = (actions: readonly string[]) => ({
  ok: true,
  personId: 'person-mia',
  businessKey: 'alpha',
  grants: actions.map((action) => ({ collection: 'docs', action })),
});

type Sent = { readonly name: string; readonly body: Record<string, unknown> };

/**
 * Answers each read and write by the name its path spells, records each call with its body,
 * and lets a test answer a write its own way (`writes`).
 */
function docsFetch(
  sent: Sent[],
  actions: readonly string[],
  writes: Readonly<
    Record<string, (body: Record<string, unknown>) => Response | Promise<Response>>
  > = {},
) {
  return async (input: unknown, init?: RequestInit) => {
    const path = String(input instanceof Request ? input.url : input);
    const match = /\/([a-z_]+)\/([a-z_]+)$/u.exec(path);
    const name = match === null ? path : `${match[1]}.${match[2]}`;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ name, body });
    if (name === 'session.capabilities') return json(capabilities(actions));
    if (name === 'docs.tree') return json(TREE);
    if (name === 'docs.page') return json(PAGE);
    const write = writes[name];
    if (write !== undefined) return await write(body);
    return json({ ok: true, detail: { folderId: 'f-new', pageId: 'p-new', version: 3 } });
  };
}

/** The server's answer to a save against a version the page has moved past. */
const stale = () =>
  json({ refused: true, code: 'VERSION_STALE', names: ['expectedVersion'], fixes: [] }, 409);

/** The server's answer to a folder name the parent holds already. */
const taken = () =>
  json(
    {
      refused: true,
      code: 'UNIQUE_VALUE_TAKEN',
      names: ['name'],
      fixes: ['Choose another name.'],
    },
    409,
  );

const writesOf = (sent: readonly Sent[], name: string) => sent.filter((one) => one.name === name);

async function openPage(sent: Sent[], actions: readonly string[], writes = {}) {
  const page = await open('/docs/', { fetch: docsFetch(sent, actions, writes) });
  await settle();
  await page.view.click('[data-page-id="p-one"]');
  await settle();
  return page;
}

it('without docs:write the screen draws no Edit, New, Rename or Move', async () => {
  const page = await openPage([], ['read']);
  expect(page.view.find('article .md__h')?.textContent).toBe('Welcome');
  expect(page.view.find('[data-docs-act]')).toBeNull();
  expect(page.view.find('textarea')).toBeNull();
});

it('Edit opens the Markdown in a textarea beside its preview, and Save sends the version it opened', async () => {
  const sent: Sent[] = [];
  const page = await openPage(sent, ['read', 'write']);
  await page.view.click('[data-docs-act="edit"]');
  const area = page.view.find('textarea[data-docs-draft]') as HTMLTextAreaElement | null;
  expect(area?.value).toBe('# Welcome');
  await page.view.type('textarea[data-docs-draft]', '# Welcome\n\n<script>alert(1)</script>');
  expect(page.view.find('[data-docs-preview] .md__h')?.textContent).toBe('Welcome');
  expect(page.view.find('[data-docs-preview] script')).toBeNull();
  await page.view.click('[data-docs-act="save"]');
  await settle();
  const [save] = writesOf(sent, 'docs.update_page');
  expect(save?.body).toMatchObject({
    pageId: 'p-one',
    expectedVersion: 2,
    body: '# Welcome\n\n<script>alert(1)</script>',
  });
  expect(page.view.find('textarea[data-docs-draft]')).toBeNull();
  // The page is read again after the save, never patched from the draft.
  expect(writesOf(sent, 'docs.page').length).toBeGreaterThan(1);
});

it('Cancel closes the editor and sends nothing', async () => {
  const sent: Sent[] = [];
  const page = await openPage(sent, ['read', 'write']);
  await page.view.click('[data-docs-act="edit"]');
  await page.view.type('textarea[data-docs-draft]', 'changed');
  await page.view.click('[data-docs-act="cancel"]');
  expect(page.view.find('textarea[data-docs-draft]')).toBeNull();
  expect(writesOf(sent, 'docs.update_page')).toHaveLength(0);
});

it('a page that changed since it was opened is the plain message, and the draft is kept', async () => {
  const sent: Sent[] = [];
  const page = await openPage(sent, ['read', 'write'], { 'docs.update_page': stale });
  await page.view.click('[data-docs-act="edit"]');
  await page.view.type('textarea[data-docs-draft]', 'my words');
  await page.view.click('[data-docs-act="save"]');
  await settle();
  expect(page.view.text()).toContain('This page changed since you opened it');
  expect((page.view.find('textarea[data-docs-draft]') as HTMLTextAreaElement | null)?.value).toBe(
    'my words',
  );
});

it('a save whose answer never arrived goes again under the same operation id', async () => {
  const sent: Sent[] = [];
  let calls = 0;
  const lost = () => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new TypeError('network'))
      : json({ ok: true, detail: { version: 3 } });
  };
  const page = await openPage(sent, ['read', 'write'], { 'docs.update_page': lost });
  await page.view.click('[data-docs-act="edit"]');
  await page.view.type('textarea[data-docs-draft]', 'once');
  await page.view.click('[data-docs-act="save"]');
  await settle();
  await page.view.click('[data-docs-act="save"]');
  await settle();
  const saves = writesOf(sent, 'docs.update_page');
  expect(saves).toHaveLength(2);
  expect(saves[1]?.body['operationId']).toBe(saves[0]?.body['operationId']);
});

it('a business switch drops the draft', async () => {
  const page = await openPage([], ['read', 'write']);
  await page.view.click('[data-docs-act="edit"]');
  await page.view.type('textarea[data-docs-draft]', 'alpha words');
  page.sessions.set(session('bravo'));
  await settle();
  expect(page.view.text()).not.toContain('alpha words');
  expect(page.view.find('textarea[data-docs-draft]')).toBeNull();
});

it('New folder and New document send the piece 1 commands', async () => {
  const sent: Sent[] = [];
  const page = await openPage(sent, ['read', 'write']);

  await page.view.click('[data-docs-act="new-folder"]');
  await page.view.type('input[data-docs-field="name"]', 'Recipes');
  await page.view.click('[data-docs-act="send"]');
  await settle();
  expect(writesOf(sent, 'docs.create_folder')[0]?.body).toMatchObject({ name: 'Recipes' });

  await page.view.click('[data-docs-act="new-page"]');
  await page.view.choose('select[data-docs-field="folder"]', 'f-other');
  await page.view.type('input[data-docs-field="title"]', 'Leave');
  await page.view.click('[data-docs-act="send"]');
  await settle();
  expect(writesOf(sent, 'docs.create_page')[0]?.body).toMatchObject({
    folderId: 'f-other',
    title: 'Leave',
    body: '',
  });
});

it('Rename and Move send the 4a commands, and a page moves as a save of its version', async () => {
  const sent: Sent[] = [];
  const page = await openPage(sent, ['read', 'write']);

  await page.view.click('[data-docs-act="rename-folder"][data-folder-id="f-top"]');
  await page.view.type('input[data-docs-field="name"]', 'Staff handbook');
  await page.view.click('[data-docs-act="send"]');
  await settle();
  expect(writesOf(sent, 'docs.rename_folder')[0]?.body).toMatchObject({
    folderId: 'f-top',
    name: 'Staff handbook',
  });

  await page.view.click('[data-docs-act="move-folder"][data-folder-id="f-top"]');
  await page.view.choose('select[data-docs-field="folder"]', 'f-other');
  await page.view.click('[data-docs-act="send"]');
  await settle();
  expect(writesOf(sent, 'docs.move_folder')[0]?.body).toMatchObject({
    folderId: 'f-top',
    parentId: 'f-other',
  });

  await page.view.click('[data-docs-act="move-page"]');
  await page.view.choose('select[data-docs-field="folder"]', 'f-other');
  await page.view.click('[data-docs-act="send"]');
  await settle();
  expect(writesOf(sent, 'docs.update_page')[0]?.body).toMatchObject({
    pageId: 'p-one',
    expectedVersion: 2,
    folderId: 'f-other',
  });
  // Each act read the tree again after its answer.
  expect(writesOf(sent, 'docs.tree').length).toBeGreaterThan(3);
});

it('a refused act shows the server’s words and keeps what was typed', async () => {
  const page = await openPage([], ['read', 'write'], { 'docs.create_folder': taken });
  await page.view.click('[data-docs-act="new-folder"]');
  await page.view.type('input[data-docs-field="name"]', 'Handbook');
  await page.view.click('[data-docs-act="send"]');
  await settle();
  expect(page.view.text()).toContain('Choose another name.');
  expect((page.view.find('input[data-docs-field="name"]') as HTMLInputElement | null)?.value).toBe(
    'Handbook',
  );
});
