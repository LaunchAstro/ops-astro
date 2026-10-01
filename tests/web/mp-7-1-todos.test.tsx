// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-1's Projects dock panel, the reader's own to-dos (CS-7.23): every row a
// real task from `task.todos`, its name opening that task in the dock task
// panel and its page door; due as urgency words on the business day, with one
// "today" (overdue included) for every derivation; the done tick running the
// one completion transition, `task.complete`. The read itself (its filter to
// the reader, isolation and refusals) is the server suite for `task.todos`.
// Search, the reading line and sort are mp-7-1-todos-search.test.tsx.

import { afterEach, describe, expect, it } from 'vitest';
import { PANELS } from '../../apps/web/src/panels.ts';
import { matchRoute, pathTo } from '../../apps/web/src/routes.ts';
import { tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { NOW, TODOS, dueOf, keysOf, serving, todos } from './todos-support.tsx';

afterEach(unmountAll);

describe('MP-7-1 the Projects dock panel', () => {
  it('the dock carries a Projects panel at an address of its own', () => {
    const panel = PANELS.todos;
    expect(panel?.label).toBe('Projects');
    expect(panel?.route).toBe('agency:todos');
    expect(matchRoute(pathTo('agency:todos'))?.id).toBe('agency:todos');
  });

  it('The board door goes to /projects/', async () => {
    const { view } = await todos();
    expect(view.find('[data-todos="board"]')?.getAttribute('href')).toBe('/projects/');
  });
});

describe('MP-7-1 Every row is a real task, and its name opens that task with its page door', () => {
  it('the rows are the read’s tasks and nothing else', async () => {
    const { view } = await todos();
    expect(keysOf(view)).toHaveLength(TODOS.length);
    const empty = await todos({ client: serving([]).client });
    expect(keysOf(empty.view)).toStrictEqual([]);
    expect(empty.view.find('[data-todos-empty]')).not.toBeNull();
  });

  it('the name opens the task in the dock task panel; the page door is its own address', async () => {
    const { view, opened } = await todos();
    await view.click('[data-todo-row="Proj-Bravo"] [data-todo-open]');
    expect(opened).toStrictEqual(['Proj-Bravo:open']);
    const door = view.find('[data-todo-row="Proj-Bravo"] [data-todo-page]');
    expect(door?.getAttribute('href')).toBe('/task/Proj-Bravo');
  });
});

describe('MP-7-1 Due as urgency words', () => {
  it('overdue, today, tomorrow, this week, later and none, on the business day', async () => {
    const { view } = await todos();
    expect(
      ['Proj-Alpha', 'Proj-Bravo', 'Proj-Charlie', 'Proj-Delta', 'Proj-Echo', 'Proj-Foxtrot'].map(
        (key) => dueOf(view, key),
      ),
    ).toStrictEqual(['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'No due date']);
  });
});

describe('MP-7-1 "today" includes overdue', () => {
  it('the today scope keeps the overdue row and today’s, and no other', async () => {
    const { view } = await todos();
    await view.click('[data-todos="today"]');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha', 'Proj-Bravo']);
  });
});

describe('MP-7-1 One "today" for every due derivation', () => {
  it('at 15:00 UTC on 30 September the business day is 1 October, for the words and the scope', async () => {
    const { view } = await todos({ now: new Date('2026-09-30T15:00:00Z') });
    expect(dueOf(view, 'Proj-Bravo')).toBe('Today');
    await view.click('[data-todos="today"]');
    const kept = keysOf(view);
    expect(kept).toStrictEqual(['Proj-Alpha', 'Proj-Bravo']);
    for (const key of kept) expect(['Overdue', 'Today']).toContain(dueOf(view, key ?? ''));
    expect(NOW.toISOString()).toBe('2026-10-01T02:00:00.000Z');
  });
});

describe('MP-7-1 The done tick runs the one completion transition', () => {
  it('the tick sends task.complete at the row’s revision, then reads the list again', async () => {
    const server = serving();
    const { view } = await todos({ client: server.client });
    await view.click('[data-todo-row="Proj-Bravo"] [data-todo-tick]');
    await tick();
    const writes = server.sent.filter((one) => one.to !== '/task/todos');
    expect(
      writes.map((one) => [one.to, one.body['recordId'], one.body['expectedRevision']]),
    ).toStrictEqual([['/task/complete', 'id-Proj-Bravo', 3]]);
    expect(server.sent.filter((one) => one.to === '/task/todos')).toHaveLength(2);
  });

  it('a person without task:write is refused: the refusal is shown and nothing else changes', async () => {
    const server = serving(TODOS, ['/task/complete']);
    const { view } = await todos({ client: server.client });
    await view.click('[data-todo-row="Proj-Bravo"] [data-todo-tick]');
    await tick();
    expect(view.find('[data-todos-refusal]')?.textContent).not.toBe('');
    expect(view.find('[data-todos-refusal]')).not.toBeNull();
    expect(keysOf(view)).toHaveLength(TODOS.length);
    expect(server.sent.filter((one) => one.to === '/task/todos')).toHaveLength(1);
  });
});
