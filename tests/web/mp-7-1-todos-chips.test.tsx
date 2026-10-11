// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-1's filter chips (XC 2-11, PJ-02 to PJ-04): a typed word that names an
// urgency, a priority, a category, whose move it is or a waiting reply scopes
// the list by it, and Enter turns the typed words into chips. A chip is
// removed by its cross, and Backspace in the empty box drops the last one.
// Every chip is read back in the "Reading this as" line.
//
// The list keeps what the person chose across a reread (#885): a tick or a
// write in the task panel reads the list again under the same search, chips,
// sort and comment scope.

import { afterEach, describe, expect, it } from 'vitest';
import { press, typeInto, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { TODOS, keysOf, serving, todos } from './todos-support.tsx';

afterEach(unmountAll);

const SEARCH = '#todos-search';

type View = Awaited<ReturnType<typeof todos>>['view'];

const reading = (view: View): string | null | undefined =>
  view.find('[data-todos-reading]')?.textContent;

const chips = (view: View): readonly (string | null)[] =>
  view.all('[data-todos-chip]').map((chip) => (chip as HTMLElement).dataset['todosChip'] ?? null);

describe('MP-7-1 XC 5 urgency words', () => {
  it('overdue keeps the overdue row, and late reads the same', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'overdue');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
    expect(reading(view)).toBe('Reading this as: due overdue');
    await typeInto(view, SEARCH, 'LATE');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
  });

  it('today keeps overdue and today, and soon keeps tomorrow and this week', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'today');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha', 'Proj-Bravo']);
    await typeInto(view, SEARCH, 'soon');
    expect(keysOf(view)).toStrictEqual(['Proj-Charlie', 'Proj-Delta']);
    expect(reading(view)).toBe('Reading this as: due soon');
  });
});

describe('MP-7-1 XC 6, 7 priority and category words', () => {
  it('p1 keeps the P1 row', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'P1');
    expect(keysOf(view)).toStrictEqual(['Proj-Bravo']);
    expect(reading(view)).toBe('Reading this as: priority P1');
  });

  it('a category by its label, three letters or more, keeps its rows', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'seo');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
    expect(reading(view)).toBe('Reading this as: category “SEO”');
    await typeInto(view, SEARCH, 'cont');
    expect(keysOf(view)).toStrictEqual(['Proj-Bravo']);
  });
});

describe('MP-7-1 XC 9, 10 waiting reply and whose move', () => {
  it('waiting keeps the rows with client messages owed a reply', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'waiting');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
    expect(reading(view)).toBe('Reading this as: waiting on a reply');
  });

  it('review, agent and team keep the rows whose move it is', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'review');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
    expect(reading(view)).toBe('Reading this as: whose move Review');
    await typeInto(view, SEARCH, 'agent');
    expect(keysOf(view)).toStrictEqual(['Proj-Bravo']);
    await typeInto(view, SEARCH, 'team');
    expect(keysOf(view)).toStrictEqual(['Proj-Charlie', 'Proj-Delta', 'Proj-Echo', 'Proj-Foxtrot']);
  });
});

describe('a word that names an inherited object property is a name word', () => {
  it('constructor keeps the task named with it, reads as a name, and commits a words chip', async () => {
    const rows = [
      { ...TODOS[5], id: 'id-Proj-A', key: 'Proj-A', title: 'Fix constructor' },
      { ...TODOS[2], id: 'id-Proj-B', key: 'Proj-B', title: 'Audit links', tags: [] },
    ];
    const { view } = await todos({ client: serving(rows).client });
    await typeInto(view, SEARCH, 'constructor');
    expect(keysOf(view)).toStrictEqual(['Proj-A']);
    expect(reading(view)).toBe('Reading this as: name “constructor”');
    await press(view, SEARCH, 'Enter');
    expect(chips(view)).toStrictEqual(['words']);
    expect(keysOf(view)).toStrictEqual(['Proj-A']);
    // Lower-cased, toString, valueOf and hasOwnProperty are no inherited keys; __proto__ is.
    await typeInto(view, SEARCH, '__proto__');
    expect(reading(view)).toBe('Reading this as: name “constructor”, name “__proto__”');
  });
});

describe('MP-7-1 XC 2, 11 chips: Enter makes them, the cross and Backspace remove them', () => {
  it('Enter turns the typed words into chips and empties the box; the scope stays', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'today p2');
    await press(view, SEARCH, 'Enter');
    expect(chips(view)).toStrictEqual(['due', 'priority']);
    expect(view.host.querySelector<HTMLInputElement>(SEARCH)?.value).toBe('');
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
    expect(reading(view)).toBe('Reading this as: due today, priority P2');
    await typeInto(view, SEARCH, 'budget');
    expect(reading(view)).toBe('Reading this as: due today, priority P2, name “budget”');
  });

  it('a chip’s cross removes that chip alone', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'today p1');
    await press(view, SEARCH, 'Enter');
    await view.click('[data-todos-chip="priority"] [data-todos-chip-remove]');
    expect(chips(view)).toStrictEqual(['due']);
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha', 'Proj-Bravo']);
  });

  it('Backspace in the empty box drops the last chip, and only then', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'waiting seo');
    await press(view, SEARCH, 'Enter');
    await typeInto(view, SEARCH, 'x');
    await press(view, SEARCH, 'Backspace');
    expect(chips(view)).toStrictEqual(['waiting', 'category']);
    await typeInto(view, SEARCH, '');
    await press(view, SEARCH, 'Backspace');
    expect(chips(view)).toStrictEqual(['waiting']);
  });

  it('drop the scope clears the chips with the words', async () => {
    const { view } = await todos();
    await typeInto(view, SEARCH, 'agent');
    await press(view, SEARCH, 'Enter');
    await view.click('[data-todos="clear"]');
    expect(chips(view)).toStrictEqual([]);
    expect(keysOf(view)).toHaveLength(6);
    expect(reading(view)).toBeUndefined();
  });
});

describe('a reread keeps the search, the chips, the sort and the comment scope', () => {
  it('a tick reads the list again under the same chips, words and sort', async () => {
    const gate: { answer?: () => void } = {};
    const held = new Promise<void>((resolve) => {
      gate.answer = resolve;
    });
    const server = serving(undefined, [], held);
    const { view } = await todos({ client: server.client });
    await typeInto(view, SEARCH, 'tag:legal');
    await press(view, SEARCH, 'Enter');
    await typeInto(view, SEARCH, 'budget');
    await view.click('[data-todos-sort="priority"]');
    await view.click('[data-todo-row="Proj-Alpha"] [data-todo-tick]');
    await tick();
    // The reread is in flight: the list stays drawn under the same choices.
    expect(server.sent.filter((one) => one.to === '/task/todos')).toHaveLength(2);
    expect(view.find('[data-outcome="loading"] [data-todo-row="Proj-Alpha"]')).not.toBeNull();
    expect(chips(view)).toStrictEqual(['tag']);
    gate.answer?.();
    await tick();
    expect(chips(view)).toStrictEqual(['tag']);
    expect(view.host.querySelector<HTMLInputElement>(SEARCH)?.value).toBe('budget');
    expect(view.find('[data-todos-sort="priority"]')?.getAttribute('aria-label')).toBe(
      'Sort by Priority, now ascending',
    );
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
  });

  it('a write in the task panel reads the list again under the same comment scope', async () => {
    const server = serving();
    const { view, changed } = await todos({ client: server.client });
    await view.click('[data-todo-row="Proj-Alpha"] [data-todo-comments]');
    await changed(1);
    expect(server.sent.filter((one) => one.to === '/task/todos')).toHaveLength(2);
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha']);
    expect(reading(view)).toBe('Reading this as: waiting comments on Proj-Alpha');
  });
});

describe('a completed row kept while the list rereads', () => {
  it('cannot be ticked again', async () => {
    const gate: { answer?: () => void } = {};
    const held = new Promise<void>((resolve) => {
      gate.answer = resolve;
    });
    const server = serving(undefined, [], held);
    const { view } = await todos({ client: server.client });
    await view.click('[data-todo-row="Proj-Alpha"] [data-todo-tick]');
    await tick();
    expect(view.find('[data-outcome="loading"] [data-todo-row="Proj-Alpha"]')).not.toBeNull();
    await view.click('[data-todo-row="Proj-Alpha"] [data-todo-tick]');
    await tick();
    gate.answer?.();
    await tick();
    expect(server.sent.filter((one) => one.to === '/task/complete')).toHaveLength(1);
    expect(view.find('[data-todos-refusal]')).toBeNull();
  });
});
