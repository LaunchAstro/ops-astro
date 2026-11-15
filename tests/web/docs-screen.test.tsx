// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs screen (#2493 piece 2): the business's folder tree on the left from `docs.tree`, and
// the chosen page drawn read-only on the right from `docs.page`. The page's Markdown becomes
// elements this app names; a tag in the text is text on the screen, never markup.

import { afterEach, expect, it, vi } from 'vitest';
import { open, json, settle } from './mp-2-1-support.tsx';

afterEach(() => {
  vi.restoreAllMocks();
});

const TREE = {
  ok: true,
  folders: [
    { id: 'f-top', name: 'Handbook', parentId: null },
    { id: 'f-child', name: 'Onboarding', parentId: 'f-top' },
  ],
  pages: [{ id: 'p-one', folderId: 'f-child', title: 'First week', version: 2 }],
};

const PAGE = {
  ok: true,
  document: {
    id: 'p-one',
    folderId: 'f-child',
    title: 'First week',
    body: '# Welcome\n\nRead the **handbook** first.\n\n<script>alert(1)</script>',
    version: 2,
    updatedAt: '2026-11-15T00:00:00.000Z',
  },
};

/** Answers each read by its name, taken from the path it is posted to, and records each asked. */
function docsFetch(answers: Readonly<Record<string, unknown>>, asked: string[]) {
  return (input: unknown) => {
    const path = String(input instanceof Request ? input.url : input);
    const name = /\/(docs)\/(tree|page)$/u.exec(path);
    const read = name === null ? path : `${name[1]}.${name[2]}`;
    asked.push(read);
    const answer = answers[read];
    return Promise.resolve(
      answer === undefined
        ? json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404)
        : json(answer),
    );
  };
}

it('Docs lists the folder tree and draws the chosen page read-only, with no markup from its text', async () => {
  const asked: string[] = [];
  const page = await open('/docs/', {
    fetch: docsFetch({ 'docs.tree': TREE, 'docs.page': PAGE }, asked),
  });
  await settle();
  expect(page.view.text()).toContain('Handbook');
  expect(page.view.text()).toContain('Onboarding');
  expect(page.view.find('[data-page-id="p-one"]')?.textContent).toBe('First week');
  await page.view.click('[data-page-id="p-one"]');
  await settle();
  expect(asked).toContain('docs.page');
  expect(page.view.find('article .md__h')?.textContent).toBe('Welcome');
  expect(page.view.find('article p:not(.md__h) strong')?.textContent).toBe('handbook');
  expect(page.view.find('article script')).toBeNull();
  expect(page.view.text()).toContain('<script>alert(1)</script>');
  expect(page.view.find('article textarea, article [contenteditable]')).toBeNull();
});

it('an empty tree says no docs are filed yet', async () => {
  const page = await open('/docs/', {
    fetch: docsFetch({ 'docs.tree': { ok: true, folders: [], pages: [] } }, []),
  });
  await settle();
  expect(page.view.find('[data-outcome="empty"]')).not.toBeNull();
  expect(page.view.text()).toContain('No docs yet');
});

it('a reader without docs:read sees the plain refusal instead of an empty tree', async () => {
  const page = await open('/docs/', {
    fetch: () =>
      Promise.resolve(
        json(
          {
            refused: true,
            code: 'SCOPE_NOT_GRANTED',
            names: ['docs:read'],
            fixes: ['Ask a collection manager for a docs:read grant.'],
          },
          403,
        ),
      ),
  });
  await settle();
  expect(page.view.find('[data-outcome="empty"]')).toBeNull();
  expect(page.view.text()).toContain('docs:read');
});
