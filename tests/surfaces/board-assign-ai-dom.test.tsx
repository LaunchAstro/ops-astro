// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI on the Projects board (BOARDS P-24, P-30, P-37; agent assignee
// ruling point 9), drawn on synthetic rows. The assignee menu lists the
// people, then the reader's own agents for that row, then Unassigned; a row
// with none of the reader's agents offers no AI entry at all, so nothing hints
// that anyone else's exists. A row the reader's agent holds draws the dashed
// `A` avatar and `AI`, and its tick says it sends the work to review.

import { afterEach, describe, expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow, RowActions } from '../../packages/ui/src/board/projects.ts';
import { EDIT, NOW, OPTIONS, PEOPLE, choose, labels, one, row } from './mp-5-10-cells-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const MINE = { id: 'd-mine', name: 'draft the menu' };
const ROWS: readonly ProjectRow[] = [
  row('offered', { name: 'Offered', agents: [MINE] }),
  row('plain', { name: 'Plain' }),
  row('held', {
    name: 'Held',
    assignee: { id: MINE.id, name: MINE.name, agent: true },
    agents: [MINE],
    toReview: true,
  }),
];

const REVIEW = 'The agent’s work is done — send it to Needs review for your confirmation';

const open = async (): Promise<{
  board: Mounted;
  agents: [string, string][];
  people: [string, string | null][];
}> => {
  const agents: [string, string][] = [];
  const people: [string, string | null][] = [];
  const actions: RowActions = {
    people: PEOPLE,
    onAssign: (each, person) => {
      people.push([each.id, person]);
    },
    onAssignAgent: (each, delegation) => {
      agents.push([each.id, delegation]);
    },
    onTick: () => null,
  };
  mounted = await mount(
    <ProjectsBoard
      rows={ROWS}
      withheld={0}
      stages={[]}
      href={(each) => `/tasks/${each.key}`}
      now={NOW}
      width={1400}
      viewport={1480}
      actions={actions}
    />,
  );
  return { board: mounted, agents, people };
};

describe('Assign to AI on the board: the assignee menu', () => {
  it('lists the reader’s own agents for the row after the people; choosing one assigns it', async () => {
    const { board, agents, people } = await open();
    await board.click(EDIT('offered', 'assignee'));
    expect(labels(board, 'offered', 'assignee')).toStrictEqual([
      'Ana Lee',
      'Ben Ito',
      'Assign to AI: draft the menu',
      'Unassigned',
    ]);
    await choose(board, 'offered', 'assignee', 'Assign to AI: draft the menu');
    expect(agents).toStrictEqual([['offered', 'd-mine']]);
    expect(people).toStrictEqual([]);
  });

  it('a row with none of the reader’s agents offers no AI entry', async () => {
    const { board } = await open();
    await board.click(EDIT('plain', 'assignee'));
    expect(labels(board, 'plain', 'assignee')).toStrictEqual(['Ana Lee', 'Ben Ito', 'Unassigned']);
  });

  it('a row the reader’s agent holds has it chosen; Unassigned clears it through the person path', async () => {
    const { board, people } = await open();
    await board.click(EDIT('held', 'assignee'));
    expect(
      board.all(OPTIONS('held', 'assignee')).map((option) => option.getAttribute('aria-selected')),
    ).toStrictEqual(['false', 'false', 'true', 'false']);
    await choose(board, 'held', 'assignee', 'Unassigned');
    expect(people).toStrictEqual([['held', null]]);
  });
});

describe('Assign to AI on the board: the row', () => {
  it('an agent’s row draws the dashed A and AI, and its tick sends the work to review', async () => {
    const { board } = await open();
    const cell = one(board, 'tr[data-row="held"] td[data-key="assignee"]');
    expect(cell?.querySelector('.cbd__av.is-agent')?.textContent).toBe('A');
    expect(cell?.querySelector('.cbd__nm')?.textContent).toBe('AI');
    const tick = one(board, 'tr[data-row="held"] input.cbd__tick');
    expect(tick?.getAttribute('title')).toBe(REVIEW);
    expect(tick?.getAttribute('aria-label')).toBe('Send Held to review');
    const plain = one(board, 'tr[data-row="plain"] input.cbd__tick');
    expect(plain?.hasAttribute('title')).toBe(false);
    expect(plain?.getAttribute('aria-label')).toBe('Complete Plain');
  });
});
