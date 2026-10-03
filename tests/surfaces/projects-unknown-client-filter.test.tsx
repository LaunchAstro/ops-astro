// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/project-row.ts';
import { facetId } from '../../packages/ui/src/board/project-facets.ts';
import { mount } from './mount.tsx';

const row = (id: string, client: string): ProjectRow => ({
  id,
  key: id,
  name: id,
  client,
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
});

// Sol OW-101.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('an unknown client filter cannot hide Client while both clients remain shown', async () => {
  const query = new URLSearchParams({ f: facetId('Client', 'No such client') });
  const control = await mount(
    <ProjectsBoard
      rows={[row('a', 'Alpha'), row('b', 'Beta')]}
      stages={[]}
      href={(one) => `/tasks/${one.id}`}
      address="f="
      now={new Date(2026, 9, 4)}
      width={1400}
      viewport={1480}
    />,
  );
  try {
    expect(control.find('th[data-key="client"]')).not.toBeNull();
  } finally {
    await control.unmount();
  }
  const board = await mount(
    <ProjectsBoard
      rows={[row('a', 'Alpha'), row('b', 'Beta')]}
      stages={[]}
      href={(one) => `/tasks/${one.id}`}
      address={query.toString()}
      now={new Date(2026, 9, 4)}
      width={1400}
      viewport={1480}
    />,
  );
  try {
    expect(board.all('tr[data-row]').map((one) => one.getAttribute('data-row'))).toEqual([
      'a',
      'b',
    ]);
    expect(
      board.find('th[data-key="client"]'),
      'unknown filters are dropped at intake',
    ).not.toBeNull();
  } finally {
    await board.unmount();
  }
});
