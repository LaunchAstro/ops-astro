// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A filter still on after a reread dropped the rows that offered it (a held
// filter, #902) is the person's own: the funnel menu shows it ticked and can
// untick it, and dropping its tag, Clear all and undo each treat it as the
// filter it is, named after the person.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/project-row.ts';
import { mount, type Mounted } from './mount.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const ANA = { id: 'p-ana', name: 'Ana', agent: false };
const BEN = { id: 'p-ben', name: 'Ben', agent: false };

const launch = (assignee: ProjectRow['assignee']): ProjectRow => ({
  id: 'task-1',
  key: 'task-1',
  name: 'Launch',
  client: null,
  rank: { number: null, calc: '' },
  starred: false,
  assignee,
  due: null,
  completed: false,
  stage: null,
  status: 'Active',
  statusPosition: 1,
  waitReason: null,
  category: null,
  awaitingDecision: false,
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
});

const board = (rows: readonly ProjectRow[]) => (
  <ProjectsBoard
    rows={rows}
    stages={[]}
    href={(one) => `/tasks/${one.id}`}
    address="f="
    viewerOn={false}
    viewer={null}
    now={new Date(2026, 9, 4)}
    width={1400}
    viewport={1480}
  />
);

const click = async (target: Element | null): Promise<void> => {
  if (target === null) throw new Error('nothing to press');
  await act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const tags = (on: Mounted) => on.all('.cbd__tag').map((tag) => tag.textContent ?? '');

/** Ben's filter on, then his row moves to Ana: the filter is held. */
async function heldBen(): Promise<Mounted> {
  view = await mount(board([launch(BEN)]));
  await view.type('[data-board-search]', 'ben');
  const field = view.find('[data-board-search]')!;
  await act(() => {
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  await view.render(board([launch(ANA)]));
  expect(tags(view).some((tag) => tag.includes('Ben'))).toBe(true);
  return view;
}

it('the funnel menu shows a held filter ticked and unticking it drops the filter', async () => {
  const on = await heldBen();
  await click(on.find('[data-funnel]'));
  const ben = on.all('[data-add]').find((one) => one.textContent === 'Ben');
  expect(ben?.getAttribute('aria-pressed')).toBe('true');
  await click(ben ?? null);
  expect(tags(on).some((tag) => tag.includes('Ben'))).toBe(false);
});

it('dropping a held filter’s tag is named after the person, and undo brings it back', async () => {
  const on = await heldBen();
  const tag = on.all('.cbd__tag').find((one) => one.textContent?.includes('Ben') === true);
  await click(tag?.querySelector('.cbd__tagx') ?? null);
  expect(tags(on).some((one) => one.includes('Ben'))).toBe(false);
  expect((on.find('[data-undo]') as HTMLButtonElement).title).toBe('Undo drop Ben');
  await click(on.find('[data-undo]'));
  expect(tags(on).some((one) => one.includes('Ben'))).toBe(true);
});

it('Clear all drops a held filter, and undo brings it back', async () => {
  const on = await heldBen();
  await click(on.find('.cbd__clear'));
  expect(tags(on).some((one) => one.includes('Ben'))).toBe(false);
  await click(on.find('[data-undo]'));
  expect(tags(on).some((one) => one.includes('Ben'))).toBe(true);
});
