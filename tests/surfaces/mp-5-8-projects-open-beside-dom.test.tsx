// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8 open beside (CS-5.10, CS-5.14): a row opens its task in the dock
// task panel beside the board (MP-4-8's panel, through the host the
// application hands every screen), by a plain click on its name or by the
// keyboard on that link, and the page stays the board. The opened row's
// name is the door focus returns to when the panel closes, and a change
// made in the panel is the board's next read. The comment badge opens the
// task on its conversation (P-36).

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/projects.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SCREENS, type TaskPanelHost } from '../../apps/web/src/screen-registry.tsx';
import { mount, settle, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const task = (id: string, key: string) => ({
  id,
  key,
  title: `Task ${key}`,
  state: { id: 's-active', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  actualMinutes: 0,
  statePosition: 1,
  waitReason: null,
  awaitingDecision: false,
});

type Opened = readonly [string, string, string | undefined];

/** The Projects screen over two tasks, with a panel host that records what it is asked to open. */
const screen = async (changes = 0, route = false) => {
  const reads: string[] = [];
  const opened: Opened[] = [];
  const fetch = ((url: string) => {
    reads.push(String(url));
    return Promise.resolve(
      new Response(
        JSON.stringify({ ok: true, tasks: [task(A, 'TSK-1'), task(B, 'TSK-2')], changedAt: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  const host = (count: number): TaskPanelHost => ({
    open: (key, door, tab) => {
      opened.push([key, door, tab]);
    },
    changes: count,
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  // `route`: as the application draws the board, through its screen registry.
  const element = (count: number) =>
    route ? (
      SCREENS['agency:projects-board']({
        client,
        grantKey: 'alpha:ada',
        params: {},
        notice: null,
        storage: null,
        taskPanel: host(count),
      })
    ) : (
      <Projects client={client} grantKey="alpha:ada" taskPanel={host(count)} />
    );
  mounted = await mount(element(changes));
  await settle();
  const boardReads = () => reads.filter((url) => url.includes('task/board')).length;
  return { board: mounted, opened, boardReads, rerender: element };
};

const NAME = (id: string): string => `tr[data-row="${id}"] .cbd__nm`;

const press = async (target: Element | null): Promise<void> => {
  await act(async () => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(300);
  });
};

describe('MP-5-8 open beside, from the Projects screen', () => {
  it('a plain click on a row’s name opens its task in the panel, and the page stays the board', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { board, opened } = await screen();
      const before = window.location.href;
      await press(board.host.querySelector(NAME(A)));
      expect(opened).toStrictEqual([['TSK-1', 'open', undefined]]);
      expect(window.location.href).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the name is a link, so the keyboard reaches it and Enter opens it', async () => {
    const { board } = await screen();
    const link = board.host.querySelector(NAME(A));
    expect([link?.tagName, link?.getAttribute('href')]).toStrictEqual(['A', '/task/TSK-1']);
  });

  it('the opened row’s name, and only that one, is the door focus returns to', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { board } = await screen();
      expect(board.all('[data-panel-door]')).toHaveLength(0);
      await press(board.host.querySelector(NAME(B)));
      expect(board.all('[data-panel-door="open"]')).toStrictEqual([
        board.host.querySelector(NAME(B)),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a change made in the panel is the board’s next read', async () => {
    const { board, boardReads, rerender } = await screen(0);
    const first = boardReads();
    await board.render(rerender(1));
    await settle();
    expect(boardReads()).toBe(first + 1);
  });
});

const row = (id: string, over: Partial<ProjectRow> = {}): ProjectRow => ({
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
  comments: { client: 2, mentions: 1, latest: null },
  ...over,
});

describe('MP-5-8 comment badge door, beside the board', () => {
  it('pressing the badge opens that task on its conversation, and marks it as the door', async () => {
    const asked: string[] = [];
    const board = (opened?: { readonly id: string; readonly door: 'open' | 'reply' }) => (
      <ProjectsBoard
        rows={[row('a'), row('b')]}
        withheld={0}
        stages={[]}
        href={(each) => `/tasks/${each.key}`}
        now={new Date(2026, 8, 30, 10, 0)}
        width={1400}
        viewport={1480}
        actions={{
          onOpenComments: (each) => {
            asked.push(each.id);
          },
          ...(opened === undefined ? {} : { opened }),
        }}
      />
    );
    mounted = await mount(board());
    const badge = mounted.host.querySelector('tr[data-row="b"] .cbd__cmt');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(() => {
      badge?.dispatchEvent(event);
    });
    expect([asked, event.defaultPrevented]).toStrictEqual([['b'], true]);
    await mounted.render(board({ id: 'b', door: 'reply' }));
    expect(mounted.all('[data-panel-door="reply"]')).toStrictEqual([
      mounted.host.querySelector('tr[data-row="b"] .cbd__cmt'),
    ]);
  });
});

describe('MP-5-8 open beside, from the application’s board route', () => {
  it('the board route hands its rows the application’s panel host, so a click opens beside', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { board, opened } = await screen(0, true);
      await press(board.host.querySelector(NAME(A)));
      expect(opened).toStrictEqual([['TSK-1', 'open', undefined]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
