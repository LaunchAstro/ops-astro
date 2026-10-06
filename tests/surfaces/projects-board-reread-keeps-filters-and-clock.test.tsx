// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The Projects board under a reread (#902, #903). A filter that is on stays
// on when the rows that offered it are gone: the view narrows to nothing and
// says so, until the person drops it. And a board drawn on the real clock
// takes the clock again when fresh rows arrive, so a day that has turned is
// judged on the new day.

import { afterEach, expect, it, vi } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/project-row.ts';
import { viewerFacetId } from '../../packages/ui/src/board/project-facets.ts';
import { mount } from './mount.tsx';

afterEach(() => {
  vi.useRealTimers();
});

const row = (id: string, over: Partial<ProjectRow> = {}): ProjectRow => ({
  id,
  key: id,
  name: id,
  client: null,
  rank: { number: null, calc: '' },
  starred: false,
  assignee: null,
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
  ...over,
});

const ben = { id: 'p-ben', name: 'Ben', agent: false };
const ana = { id: 'p-ana', name: 'Ana', agent: false };

const shown = (board: Awaited<ReturnType<typeof mount>>) =>
  board.all('tr[data-row]').map((one) => (one as HTMLElement).dataset['row'] ?? null);

it('#902 a reread that drops the last row of an active filter shows no task, and keeps the filter', async () => {
  const board = (rows: readonly ProjectRow[]) => (
    <ProjectsBoard
      rows={rows}
      stages={[]}
      href={(one) => `/tasks/${one.id}`}
      address={new URLSearchParams({ f: viewerFacetId(ben.id) }).toString()}
      viewerOn={false}
      now={new Date(2026, 9, 4)}
      width={1400}
      viewport={1480}
    />
  );
  const view = await mount(
    board([row('ben-1', { assignee: ben }), row('ana-1', { assignee: ana })]),
  );
  try {
    expect(shown(view)).toEqual(['ben-1']);
    await view.render(board([row('ben-1', { assignee: ana }), row('ana-1', { assignee: ana })]));
    expect(shown(view), 'the reread widened the view to another person’s tasks').toEqual([]);
    expect(
      view.all('.cbd__tag').map((tag) => tag.textContent),
      'the active filter vanished from the tags',
    ).toContainEqual(expect.stringContaining('Ben'));
  } finally {
    await view.unmount();
  }
});

/** A board on the real clock, filtered to overdue. */
const clockBoard = (rows: readonly ProjectRow[], changedAt: string) => (
  <ProjectsBoard
    rows={rows}
    stages={[]}
    href={(one) => `/tasks/${one.id}`}
    address={new URLSearchParams({ f: 'due:overdue' }).toString()}
    viewerOn={false}
    changedAt={changedAt}
    width={1400}
    viewport={1480}
  />
);

it('#903 a board on the real clock judges overdue on the new day once fresh rows arrive', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 23, 59));
  const due = '2026-10-04';
  const view = await mount(clockBoard([row('today', { due })], new Date().toISOString()));
  try {
    expect(shown(view)).toEqual([]);
    vi.setSystemTime(new Date(2026, 9, 5, 0, 1));
    await view.render(clockBoard([row('today', { due })], new Date().toISOString()));
    expect(shown(view), 'yesterday’s open task is not overdue on the new day').toEqual(['today']);
  } finally {
    await view.unmount();
  }
});

it('#902 Review still drops a held assignee filter', async () => {
  const board = (rows: readonly ProjectRow[]) => (
    <ProjectsBoard
      rows={rows}
      stages={[]}
      href={(one) => `/tasks/${one.id}`}
      address={new URLSearchParams({ f: viewerFacetId(ben.id) }).toString()}
      viewerOn={false}
      now={new Date(2026, 9, 4)}
      width={1400}
      viewport={1480}
    />
  );
  const waiting = { assignee: ana, awaitingDecision: true };
  const view = await mount(board([row('ben-1', { assignee: ben }), row('ana-1', waiting)]));
  try {
    await view.render(board([row('ben-1', { assignee: ana }), row('ana-1', waiting)]));
    await view.click('.cbd__mode[data-mode="review"]');
    expect(shown(view), 'the held Ben filter hid the task waiting on a decision').toEqual([
      'ana-1',
    ]);
  } finally {
    await view.unmount();
  }
});
