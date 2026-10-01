// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-1's to-dos search and sort (CS-7.23, CS-7.24): typed tokens scope the
// list by name, by tag (`tag:`) and by due (`due:today`), read back in the
// "Reading this as" line; a task's comment count scopes it to that task;
// dropping the scope clears it. Sort by task, due and priority. None of it
// writes. The sort is kept for the session; remembering it for the person
// leans on the preference store (MP-2-11a).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { keysOf, serving, todos } from './todos-support.tsx';

afterEach(unmountAll);

const SEARCH = '#todos-search';

describe('MP-7-1 Token search with the tag kinds and the reading line', () => {
  it('a word scopes by name, whatever its case', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'BRIEF');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
    expect(view.find('[data-todos-reading]')?.textContent).toBe('Reading this as: name “brief”');
  });

  it('tag: scopes by the tag, and the tokens are read back together', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'tag:LEGAL');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
    await typeInto(view, SEARCH, 'tag:launch audit');
    expect(keysOf(view)).toStrictEqual(['Proj-Charlie']);
    expect(view.find('[data-todos-reading]')?.textContent).toBe(
      'Reading this as: tag “launch”, name “audit”',
    );
  });

  it('due:today scopes to today with overdue, and drop the scope clears it', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'due:today');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha', 'Proj-Bravo']);
    expect(view.find('[data-todos-reading]')?.textContent).toBe('Reading this as: due today');
    await view.click('[data-todos="clear"]');
    expect(keysOf(view)).toHaveLength(6);
    expect(view.host.querySelector<HTMLInputElement>(SEARCH)?.value).toBe('');
    expect(view.find('[data-todos-reading]')).toBeNull();
  });
});

describe('MP-7-1 CS-7.23 the comment count filters to that task', () => {
  it('pressing a task’s comment count keeps only that task, and says so', async () => {
    const { view } = await todos();
    expect(view.find('[data-todo-row="Proj-Bravo"] [data-todo-comments]')).toBeNull();
    await view.click('[data-todo-row="Proj-Alpha"] [data-todo-comments]');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
    expect(view.find('[data-todos-reading]')?.textContent).toBe(
      'Reading this as: waiting comments on Proj-Alpha',
    );
  });
});

describe('MP-7-1 Sort by task, due and priority', () => {
  it('due first by default (none last), then by name, then by priority (P1 first, none last)', async () => {
    const { view } = await todos();
    expect(keysOf(view)).toStrictEqual([
      'Proj-Alpha',
      'Proj-Bravo',
      'Proj-Charlie',
      'Proj-Delta',
      'Proj-Echo',
      'Proj-Foxtrot',
    ]);
    await view.choose('#todos-sort', 'task');
    expect(keysOf(view)).toStrictEqual([
      'Proj-Charlie',
      'Proj-Alpha',
      'Proj-Bravo',
      'Proj-Delta',
      'Proj-Echo',
      'Proj-Foxtrot',
    ]);
    await view.choose('#todos-sort', 'priority');
    expect(keysOf(view)).toStrictEqual([
      'Proj-Bravo',
      'Proj-Alpha',
      'Proj-Echo',
      'Proj-Delta',
      'Proj-Charlie',
      'Proj-Foxtrot',
    ]);
  });
});

describe('MP-7-1 not audited: reads, search and sort send no write', () => {
  it('typing, scoping and sorting send nothing but the reads', async () => {
    const server = serving();
    const { view } = await todos({ client: server.client });
    await typeInto(view, SEARCH, 'tag:legal');
    await view.click('[data-todos="clear"]');
    await view.choose('#todos-sort', 'priority');
    await view.click('[data-todo-row="Proj-Alpha"] [data-todo-comments]');
    // The list's one read, and the scope switch's teammates (MP-7-2).
    expect(server.sent.map((one) => one.to).toSorted()).toStrictEqual([
      '/person/list',
      '/task/todos',
    ]);
  });
});

describe('MP-7-1 Priority yields below a 380px list', () => {
  it('the priority cell is marked, and the list’s container rule hides it under 380px', async () => {
    const { view } = await todos();
    const cell = view.find('[data-todo-row="Proj-Alpha"] [data-todo-priority]');
    expect(cell?.classList.contains('todo__priority')).toBe(true);
    expect(cell?.textContent).toBe('P2');
    expect(view.find('.todos')).not.toBeNull();
    const sheet = readFileSync('apps/web/src/styles/6-slice.css', 'utf8');
    expect(sheet).toMatch(/\.todos \{[^}]*container-type: inline-size/u);
    expect(sheet).toMatch(
      /@container \(max-width: 379px\) \{\s*\.todo__priority \{\s*display: none;/u,
    );
  });
});
