// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A board that drew the page's empty words in its place, its rows gone and
// nothing on, lays its table out at the card's real width when rows come
// back: the width it measures is the card drawn now, never the one that left.
// jsdom has no ResizeObserver, so a stand-in reports a drawn card at 1400px
// and a removed one at 0, as a browser does.

import { act } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/project-row.ts';
import { mount, type Mounted } from './mount.tsx';

const CARD = 1400;

class Observer {
  static live: Observer[] = [];
  readonly watched: Element[] = [];
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    Observer.live.push(this);
  }
  observe(target: Element): void {
    this.watched.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    Observer.live = Observer.live.filter((one) => one !== this);
  }
  report(): void {
    const entries = this.watched.map(
      (target) =>
        ({
          target,
          contentRect: { width: target.isConnected ? CARD : 0, height: 0 },
        }) as unknown as ResizeObserverEntry,
    );
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

beforeEach(() => {
  Observer.live = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Observer;
});

/** Every observer told the size of what it watches, after a draw. */
const measure = async (): Promise<void> => {
  await act(() => {
    for (const observer of Observer.live) observer.report();
  });
};

const task: ProjectRow = {
  id: 'task-1',
  key: 'task-1',
  name: 'Launch',
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
};

const board = (rows: readonly ProjectRow[]) => (
  <ProjectsBoard
    rows={rows}
    stages={[]}
    href={(one) => `/tasks/${one.id}`}
    address="f="
    viewerOn={false}
    now={new Date(2026, 9, 4)}
    viewport={1480}
    nothing={<p data-nothing="">No tasks on this board yet.</p>}
  />
);

/** The table's laid-out width and its columns', as drawn. */
const layout = (view: Mounted) => ({
  table: view.find('table.cbd__tbl')?.getAttribute('style') ?? null,
  columns: view.all('table.cbd__tbl col').map((col) => col.getAttribute('style')),
});

it('rows back after the empty words lay the table out at the card’s real width', async () => {
  const fresh = await mount(board([task]));
  await measure();
  const real = layout(fresh);
  await fresh.unmount();
  // A 1400px card fits the table: it draws at the card's width, with no fixed width.
  expect(real.table).toBeNull();

  const view = await mount(board([task]));
  await measure();
  await view.render(board([]));
  await measure();
  expect(view.find('[data-nothing]'), 'the bare board draws the page’s words').not.toBeNull();
  await view.render(board([task]));
  await measure();
  expect(layout(view), 'the table is laid out for a card that is no longer drawn').toEqual(real);
});
