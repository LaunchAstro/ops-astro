// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's Project select (CS-4.15, DP-22; ORCH40: a board is a project on the
// Projects board). It offers None and the projects `task.board` answers for
// the Projects board (`board: null`), never the task itself, marks the task's
// board by the id its crumb names, and moves the task through `task.move` at
// the revision the panel read. A board the reader may not open is drawn as
// that and nothing more. The server side (the move, its refusals, audit and
// isolation) is the task.move suites'; what the list holds is task.board's.

import { afterEach, describe, expect, it } from 'vitest';
import { TASK_ID, tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const WEBSITES = '44444444-4444-4444-8444-444444444444';
const RETAINER = '55555555-5555-4555-8555-555555555555';
const PROJECTS = [
  { id: WEBSITES, title: 'Website Projects' },
  { id: TASK_ID, title: 'Budget pacing fix' },
  { id: RETAINER, title: null },
];

const optionsOf = (select: HTMLSelectElement | null) =>
  [...(select?.options ?? [])].map((option) => [option.value, option.text, option.disabled]);

describe('MP-4-8 Project select', () => {
  it('offers None and the Projects board’s projects, never the task itself, with its board chosen', async () => {
    const task = { board: { readable: true, id: WEBSITES, title: 'Website Projects' } };
    const view = await panel(serving(task, [], PROJECTS).client);
    const select = view.find('#panel-field-board') as HTMLSelectElement | null;
    expect(optionsOf(select)).toStrictEqual([
      ['', 'None', false],
      [WEBSITES, 'Website Projects', false],
      [RETAINER, 'Untitled', false],
    ]);
    expect(select?.value).toBe(WEBSITES);
    await view.unmount();
  });

  it('a task on no board reads None', async () => {
    const view = await panel(serving({ board: null }, [], PROJECTS).client);
    expect((view.find('#panel-field-board') as HTMLSelectElement | null)?.value).toBe('');
    await view.unmount();
  });

  it('a board that is not a project is kept among the choices as itself', async () => {
    const other = '66666666-6666-4666-8666-666666666666';
    const task = { board: { readable: true, id: other, title: 'Q3 launch' } };
    const view = await panel(serving(task, [], PROJECTS).client);
    const select = view.find('#panel-field-board') as HTMLSelectElement | null;
    expect(optionsOf(select)).toContainEqual([other, 'Q3 launch', false]);
    expect(select?.value).toBe(other);
    await view.unmount();
  });

  it('a board the reader may not open is drawn as that and cannot be chosen', async () => {
    const view = await panel(serving({ board: { readable: false } }, [], PROJECTS).client);
    const select = view.find('#panel-field-board') as HTMLSelectElement | null;
    expect(optionsOf(select)[0]).toStrictEqual(['withheld', 'A board you cannot open', true]);
    expect(select?.value).toBe('withheld');
    await view.unmount();
  });
});

describe('MP-4-8 Project select moves the task', () => {
  it('a project and None each go through task.move at the read revision', async () => {
    const { client, sent } = serving({ board: null }, [], PROJECTS);
    const view = await panel(client);
    await view.choose('#panel-field-board', WEBSITES);
    await tick();
    await view.choose('#panel-field-board', '');
    await tick();
    expect(sent.map((one) => [one.to, one.body['recordId'], one.body['board']])).toStrictEqual([
      ['/task/move', TASK_ID, WEBSITES],
      ['/task/move', TASK_ID, null],
    ]);
    expect(sent.map((one) => one.body['expectedRevision'])).toStrictEqual([4, 4]);
    await view.unmount();
  });
});
