// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A filter the board remembers from an earlier read, and that is not on, has
// no say in a new search (#902): held filters keep the person's own
// selections and never widen what a typed word can mean. After Ben's task
// moves to Ana, the word 'ben' is a free word, as it is on a fresh board with
// the same rows.

import { act } from 'react';
import { expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/project-row.ts';
import { mount, type Mounted } from './mount.tsx';

const launch = (assignee: ProjectRow['assignee']): ProjectRow => ({
  id: 'task-1',
  key: 'task-1',
  name: 'Launch Ben',
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

const shown = (view: Mounted) =>
  view.all('tr[data-row]').map((one) => (one as HTMLElement).dataset['row'] ?? null);

async function search(view: Mounted, query: string): Promise<void> {
  await view.type('[data-board-search]', query);
  const field = view.find('[data-board-search]');
  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    field?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
}

const ANA = { id: 'p-ana', name: 'Ana', agent: false };
const BEN = { id: 'p-ben', name: 'Ben', agent: false };

it('after Ben’s task moves to Ana, a search for “ben launch” matches it as free words', async () => {
  const fresh = await mount(board([launch(ANA)]));
  await search(fresh, 'ben launch');
  expect(shown(fresh), 'a fresh board with Ana’s row').toEqual(['task-1']);
  await fresh.unmount();

  const view = await mount(board([launch(BEN)]));
  await view.render(board([launch(ANA)]));
  await search(view, 'ben launch');
  expect(shown(view), 'a filter remembered but not on turned “ben” into Ben’s filter').toEqual([
    'task-1',
  ]);
  expect(view.all('.cbd__tag').map((tag) => tag.textContent)).not.toContainEqual(
    expect.stringContaining('Ben'),
  );
});
