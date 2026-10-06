// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A mode on is something on the board for a person to drop, as a filter is:
// an empty reread with Review on keeps the Review control drawn and pressable,
// never the page's empty words in its place, and pressing it brings the
// ordinary view back with the task that arrives meanwhile.

import { expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/project-row.ts';
import { mount } from './mount.tsx';

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

const board = (rows: readonly ProjectRow[]) => (
  <ProjectsBoard
    rows={rows}
    stages={[]}
    href={(one) => `/tasks/${one.id}`}
    address="f="
    viewerOn={false}
    now={new Date(2026, 9, 4)}
    width={1400}
    viewport={1480}
    nothing={<p data-nothing="">No tasks on this board yet.</p>}
  />
);

const shown = (view: Awaited<ReturnType<typeof mount>>) =>
  view.all('tr[data-row]').map((one) => (one as HTMLElement).dataset['row'] ?? null);

it('an empty reread with Review on keeps Review drawn, and pressing it shows the task that came', async () => {
  const view = await mount(board([row('decide-1', { awaitingDecision: true })]));
  try {
    await view.click('.cbd__mode[data-mode="review"]');
    await view.render(board([]));
    expect(view.find('[data-nothing]'), 'Review on, yet the page said it has nothing').toBeNull();
    expect(
      view.find('.cbd__mode[data-mode="review"]'),
      'Review cannot be pressed off',
    ).not.toBeNull();
    await view.render(board([row('plain-1')]));
    await view.click('.cbd__mode[data-mode="review"]');
    expect(shown(view), 'the ordinary task stayed hidden behind Review').toEqual(['plain-1']);
  } finally {
    await view.unmount();
  }
});
