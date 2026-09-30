// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-11's tag field in the dock task panel (CS-4.19 to CS-4.21, DP-26 to
// DP-28): the task's tags as chips with a ×, and a combobox that suggests
// from the business's vocabulary (`tag.list`) with a "new tag" row. Typed
// text is never a tag until a row is chosen; Escape closes only the menu.
// The server side (the rules, refusals, audit, isolation) is
// tests/commands/task-tags.test.ts and task-tags-isolation.test.ts.
//
// Suggestions are the tags in use; the categories beside them wait on the
// category presets (MP-5-12, MP-5-13: SL08 handback, LEANS-ON).

import { afterEach, describe, expect, it } from 'vitest';
import { TASK_ID, tick } from './task-page-stub.tsx';
import { press, typeInto, unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const INPUT = '#panel-tag-input';
const VOCABULARY = [
  { id: 'g-launch', name: 'Launch' },
  { id: 'g-legal', name: 'Legal' },
  { id: 'g-urgent', name: 'Urgent' },
];
const ON_TASK = { tags: [{ id: 'g-urgent', name: 'Urgent' }] };

async function opened(over: Readonly<Record<string, unknown>> = ON_TASK) {
  const server = serving(over, VOCABULARY);
  const view = await panel(server.client);
  (view.find(INPUT) as HTMLInputElement).focus();
  await tick();
  return { ...server, view };
}

const rowsOf = (view: Awaited<ReturnType<typeof opened>>['view']) =>
  view.all('#panel-tag-menu [role="option"]').map((row) => row.textContent?.trim());

describe('MP-4-11 CS-4.19 type to find a tag', () => {
  it('focus opens the vocabulary without the task’s own tags; typing filters it, whatever the case', async () => {
    const { view } = await opened();
    expect(rowsOf(view)).toStrictEqual(['Launch', 'Legal']);
    await typeInto(view, INPUT, 'LE');
    expect(rowsOf(view)).toStrictEqual(['Legal', 'New tag “LE”']);
    await view.unmount();
  });

  it('suggestions are the tags in use, loaded once the field is focused', async () => {
    const server = serving(ON_TASK, VOCABULARY);
    const view = await panel(server.client);
    expect(view.find('#panel-tag-menu')).toBeNull();
    (view.find(INPUT) as HTMLInputElement).focus();
    await tick();
    expect(rowsOf(view)).toStrictEqual(['Launch', 'Legal']);
    await view.unmount();
  });

  it('not audited: typing and moving through the menu send nothing', async () => {
    const { view, sent } = await opened();
    await typeInto(view, INPUT, 'la');
    await press(view, INPUT, 'ArrowDown');
    await press(view, INPUT, 'ArrowUp');
    expect(sent).toStrictEqual([]);
    await view.unmount();
  });
});

describe('MP-4-11 CS-4.20 add an existing tag, or create a new one', () => {
  it('choosing an existing tag adds it through task.add_tag', async () => {
    const { view, sent } = await opened();
    await view.click('#panel-tag-menu [data-tag-row="g-legal"]');
    await tick();
    expect(sent.map((one) => [one.to, one.body['recordId'], one.body['tagId']])).toStrictEqual([
      ['/task/add_tag', TASK_ID, 'g-legal'],
    ]);
    await view.unmount();
  });

  it('a new tag row creates the name, then adds it to the task', async () => {
    const { view, sent } = await opened();
    await typeInto(view, INPUT, '  Brand refresh ');
    await view.click('#panel-tag-menu [data-tag-row="new"]');
    await tick();
    expect(sent.map((one) => [one.to, one.body['name'] ?? one.body['tagId']])).toStrictEqual([
      ['/tag/create', 'Brand refresh'],
      ['/task/add_tag', 'g-new'],
    ]);
    await view.unmount();
  });
});

describe('MP-4-11 a new tag row', () => {
  it('is offered only for typed text the vocabulary does not hold, in any case', async () => {
    const { view } = await opened();
    await typeInto(view, INPUT, 'launch');
    expect(rowsOf(view)).toStrictEqual(['Launch']);
    await typeInto(view, INPUT, 'urgent');
    expect(rowsOf(view)).toStrictEqual([]);
    await typeInto(view, INPUT, '   ');
    expect(rowsOf(view)).toStrictEqual(['Launch', 'Legal']);
    await view.unmount();
  });
});

describe('MP-4-11 case-insensitive duplicates refused', () => {
  it('a name the business holds in another case is never offered as new, and never sent as new', async () => {
    const { view, sent } = await opened();
    await typeInto(view, INPUT, 'LEGAL');
    await press(view, INPUT, 'Enter');
    await tick();
    expect(sent.map((one) => [one.to, one.body['tagId']])).toStrictEqual([
      ['/task/add_tag', 'g-legal'],
    ]);
    await view.unmount();
  });
});

describe('MP-4-11 arrow keys, Enter and Escape', () => {
  it('ArrowDown and ArrowUp move the marked row, and Enter adds it', async () => {
    const { view, sent } = await opened();
    const marked = () => view.find('#panel-tag-menu [aria-selected="true"]')?.textContent;
    expect(marked()).toBe('Launch');
    await press(view, INPUT, 'ArrowDown');
    expect(marked()).toBe('Legal');
    await press(view, INPUT, 'ArrowDown');
    expect(marked()).toBe('Legal');
    await press(view, INPUT, 'ArrowUp');
    expect(marked()).toBe('Launch');
    await press(view, INPUT, 'Enter');
    await tick();
    expect(sent.map((one) => [one.to, one.body['tagId']])).toStrictEqual([
      ['/task/add_tag', 'g-launch'],
    ]);
    await view.unmount();
  });

  it('Escape in the tag menu closes only the menu, never the dock task panel', async () => {
    let closed = 0;
    const server = serving(ON_TASK, VOCABULARY);
    const view = await panel(server.client, { close: () => (closed += 1) });
    (view.find(INPUT) as HTMLInputElement).focus();
    await tick();
    await press(view, INPUT, 'Escape');
    expect(view.find('#panel-tag-menu')).toBeNull();
    expect(view.find('[data-task-panel]')).not.toBeNull();
    expect(closed).toBe(0);
    await view.unmount();
  });
});

describe('MP-4-11 typed text is never a tag until chosen', () => {
  it('typing, then leaving the field, sends nothing and draws no chip', async () => {
    const { view, sent } = await opened();
    await typeInto(view, INPUT, 'Half typed');
    (view.find(INPUT) as HTMLInputElement).blur();
    await tick();
    expect(sent).toStrictEqual([]);
    expect(
      view.all('[data-tag-chip]').map((chip) => chip.getAttribute('data-tag-chip')),
    ).toStrictEqual(['g-urgent']);
    await view.unmount();
  });
});

describe('MP-4-11 CS-4.21 remove the tag from this task', () => {
  it('the chip’s × removes that tag through task.remove_tag', async () => {
    const { view, sent } = await opened();
    await view.click('[data-tag-chip="g-urgent"] button');
    await tick();
    expect(sent.map((one) => [one.to, one.body['recordId'], one.body['tagId']])).toStrictEqual([
      ['/task/remove_tag', TASK_ID, 'g-urgent'],
    ]);
    await view.unmount();
  });
});

describe('MP-4-11 panel subtasks', () => {
  it('the dock task panel shows MP-4-4’s subtask list beside the tag field', async () => {
    const { view } = await opened({ ...ON_TASK });
    expect(view.find(INPUT)).not.toBeNull();
    expect(view.find('[data-step-list]')).not.toBeNull();
    await view.unmount();
  });
});
