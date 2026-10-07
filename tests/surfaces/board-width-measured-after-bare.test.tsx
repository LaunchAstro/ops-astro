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

/** The width a drawn card reports; a test may resize the window between draws. */
let card = 1400;

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
          contentRect: { width: target.isConnected ? card : 0, height: 0 },
        }) as unknown as ResizeObserverEntry,
    );
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

beforeEach(() => {
  Observer.live = [];
  card = 1400;
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

/** The layout a board mounted with rows draws at the card's width now. */
async function freshLayout(): Promise<ReturnType<typeof layout>> {
  const fresh = await mount(board([task]));
  await measure();
  const real = layout(fresh);
  await fresh.unmount();
  return real;
}

it('rows back after the empty words lay the table out at the card’s real width', async () => {
  const real = await freshLayout();
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

it('a window resized while the board is bare lays the returning table out at the new width', async () => {
  const view = await mount(board([task]));
  await measure();
  await view.render(board([]));
  await measure();
  card = 700;
  await measure();
  await view.render(board([task]));
  await measure();
  const drawn = layout(view);
  await view.unmount();
  expect(drawn, 'the table kept the width from before the resize').toEqual(await freshLayout());
});

it('a board that mounts bare lays its first rows out at the card’s real width', async () => {
  card = 700;
  const view = await mount(board([]));
  await measure();
  await view.render(board([task]));
  await measure();
  const drawn = layout(view);
  await view.unmount();
  expect(drawn, 'the table took the fallback width, not the card').toEqual(await freshLayout());
});
