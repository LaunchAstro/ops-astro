// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-10: the synthetic rows, the board and the helpers the two cell-editor
// DOM suites share (mp-5-10-projects-cells-dom.test.tsx and
// mp-5-10-projects-cells-cancel-dom.test.tsx).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow, RowActions } from '../../packages/ui/src/board/projects.ts';
import { mount, type Mounted } from './mount.tsx';

export const NOW = new Date(2026, 8, 30, 10, 0);

export const SHEET = readFileSync(
  join(process.cwd(), 'packages/ui/src/styles/4b-board-machine.css'),
  'utf8',
);

export const row = (id: string, over: Partial<ProjectRow> = {}): ProjectRow => ({
  id,
  key: `TSK-${id}`,
  name: `Task ${id}`,
  rank: { number: null, calc: 'not ranked: missing ease' },
  starred: false,
  client: null,
  assignee: null,
  due: null,
  completed: false,
  stage: null,
  status: 'Active',
  statusPosition: 2000,
  waitReason: null,
  category: null,
  awaitingDecision: false,
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
  ...over,
});

export const ROWS: readonly ProjectRow[] = [
  row('menu', {
    name: 'Menu copy',
    assignee: { id: 'p-ana', name: 'Ana Lee', agent: false },
    due: '2026-10-05T00:00:00.000Z',
    stage: 'Drafting',
  }),
  row('flyer', { name: 'Flyer', stage: 'Review' }),
];

export const PEOPLE = [
  { id: 'p-ana', name: 'Ana Lee' },
  { id: 'p-ben', name: 'Ben Ito' },
];

let mounted: Mounted | undefined;

/** Unmounts the board `open` drew; each suite calls it after every test. */
export async function unmount(): Promise<void> {
  await mounted?.unmount();
  mounted = undefined;
}

export interface Calls {
  readonly assigns: [string, string | null][];
  readonly dues: [string, string | null][];
  readonly stages: [string, string][];
}

export const open = async (
  omit: readonly (keyof RowActions)[] | null = [],
): Promise<{
  board: Mounted;
  calls: Calls;
}> => {
  const calls: Calls = { assigns: [], dues: [], stages: [] };
  const all: RowActions = {
    people: PEOPLE,
    onAssign: (each, person) => {
      calls.assigns.push([each.id, person]);
    },
    onDue: (each, due) => {
      calls.dues.push([each.id, due]);
    },
    onStage: (each, stage) => {
      calls.stages.push([each.id, stage]);
    },
  };
  const handed = Object.fromEntries(
    Object.entries(all).filter(([name]) => !(omit ?? []).includes(name as keyof RowActions)),
  ) as RowActions;
  mounted = await mount(
    <ProjectsBoard
      rows={ROWS}
      withheld={0}
      stages={['Brief', 'Drafting']}
      href={(each) => `/tasks/${each.key}`}
      now={NOW}
      width={1400}
      viewport={1480}
      {...(omit === null ? {} : { actions: handed })}
    />,
  );
  return { board: mounted, calls };
};

export const one = (board: Mounted, selector: string): HTMLElement | null =>
  board.host.querySelector<HTMLElement>(selector);

export const CELL = (id: string, key: string): string =>
  `tr[data-row="${id}"] td[data-key="${key}"]`;
export const EDIT = (id: string, key: string): string => `${CELL(id, key)} button.cbd__edb`;
export const EDITOR = (id: string, key: string): string => `${CELL(id, key)} .cbd__ed`;
export const OPTIONS = (id: string, key: string): string =>
  `${EDITOR(id, key)} .sel__menu [role="option"]`;

export const fire = async (target: Element | null, event: Event): Promise<void> => {
  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    target?.dispatchEvent(event);
  });
};

export const press = async (target: Element | null, key: string): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await fire(target, event);
  return event;
};

export const labels = (board: Mounted, id: string, key: string): string[] =>
  board.all(OPTIONS(id, key)).map((option) => option.textContent ?? '');

export const choose = async (
  board: Mounted,
  id: string,
  key: string,
  label: string,
): Promise<void> => {
  const option = board.all(OPTIONS(id, key)).find((each) => each.textContent === label) as
    HTMLElement | undefined;
  await fire(option ?? null, new MouseEvent('click', { bubbles: true, cancelable: true }));
};
