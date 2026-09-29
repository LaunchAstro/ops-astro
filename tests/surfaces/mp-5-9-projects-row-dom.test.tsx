// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-9: the Projects board's row, drawn on synthetic rows. The tick
// completes or reopens through what the page hands in (the one completion
// transition); a double-click renames in place, Enter or blur saving, Escape
// cancelling, and a blank or unchanged name saving nothing (P-32); a plain
// click opens the task after 260ms unless a double-click follows (CS-5.14);
// the hover box holds add subtask, the door with its in-app mark, and the
// timer only when the page can start one (P-33). The last suite drives the
// commands from the Projects screen.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/projects.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const NOW = new Date(2026, 8, 30, 10, 0);

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
  comments: { client: 0, mentions: 0, latest: null },
  ...over,
});

const ROWS: readonly ProjectRow[] = [
  row('open', { name: 'Menu copy' }),
  row('done', { name: 'Brochure', completed: true, status: 'Complete', statusPosition: 5000 }),
];

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

interface Calls {
  readonly ticks: [string, boolean][];
  readonly renames: [string, string][];
  readonly opens: string[];
  readonly timers: string[];
}

const open = async (
  props: Partial<Parameters<typeof ProjectsBoard>[0]> = {},
  timer = false,
): Promise<{ board: Mounted; calls: Calls }> => {
  const calls: Calls = { ticks: [], renames: [], opens: [], timers: [] };
  mounted = await mount(
    <ProjectsBoard
      rows={ROWS}
      withheld={0}
      stages={[]}
      href={(each) => `/tasks/${each.key}`}
      now={NOW}
      width={1400}
      viewport={1480}
      actions={{
        onTick: (each, done) => {
          calls.ticks.push([each.id, done]);
        },
        onRename: (each, title) => {
          calls.renames.push([each.id, title]);
        },
        onOpen: (each) => {
          calls.opens.push(each.id);
        },
        ...(timer
          ? {
              onStartTimer: (each: ProjectRow) => {
                calls.timers.push(each.id);
              },
            }
          : {}),
      }}
      {...props}
    />,
  );
  return { board: mounted, calls };
};

const one = (board: Mounted, selector: string): HTMLElement | null =>
  board.host.querySelector<HTMLElement>(selector);

const NAME = (id: string): string => `tr[data-row="${id}"] .cbd__nm`;
const RENAME = (id: string): string => `tr[data-row="${id}"] input.cbd__rename`;

const fire = async (target: Element | null, event: Event): Promise<void> => {
  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    target?.dispatchEvent(event);
  });
};

const dbl = async (board: Mounted, id: string): Promise<void> => {
  await fire(one(board, NAME(id)), new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
};

const key = async (board: Mounted, id: string, name: string): Promise<void> => {
  await fire(one(board, RENAME(id)), new KeyboardEvent('keydown', { key: name, bubbles: true }));
};

describe('MP-5-9 double-click rename with the Enter, Escape and blur rules', () => {
  it('a double-click opens the name for editing; Enter saves the new name once', async () => {
    const { board, calls } = await open();
    await dbl(board, 'open');
    expect((one(board, RENAME('open')) as HTMLInputElement | null)?.value).toBe('Menu copy');
    await board.type(RENAME('open'), 'Menu copy v2');
    await key(board, 'open', 'Enter');
    expect(calls.renames).toStrictEqual([['open', 'Menu copy v2']]);
    expect(one(board, RENAME('open'))).toBeNull();
  });

  it('Escape cancels, saving nothing', async () => {
    const { board, calls } = await open();
    await dbl(board, 'open');
    await board.type(RENAME('open'), 'thrown away');
    await key(board, 'open', 'Escape');
    expect(calls.renames).toStrictEqual([]);
    expect(one(board, NAME('open'))?.textContent).toBe('Menu copy');
  });

  it('blur saves', async () => {
    const { board, calls } = await open();
    await dbl(board, 'open');
    await board.type(RENAME('open'), 'saved on blur');
    await fire(one(board, RENAME('open')), new FocusEvent('focusout', { bubbles: true }));
    expect(calls.renames).toStrictEqual([['open', 'saved on blur']]);
  });

  it('a blank or unchanged name saves nothing', async () => {
    const { board, calls } = await open();
    await dbl(board, 'open');
    await board.type(RENAME('open'), '   ');
    await key(board, 'open', 'Enter');
    await dbl(board, 'open');
    await key(board, 'open', 'Enter');
    expect(calls.renames).toStrictEqual([]);
  });
});

describe('MP-5-9 reopen restores', () => {
  it('the tick completes an open task and reopens a completed one', async () => {
    const { board, calls } = await open();
    await board.click('tr[data-row="open"] input.cbd__tick');
    await board.click('tr[data-row="done"] input.cbd__tick');
    expect(calls.ticks).toStrictEqual([
      ['open', true],
      ['done', false],
    ]);
    expect(
      (one(board, 'tr[data-row="done"] input.cbd__tick') as HTMLInputElement | null)?.checked,
    ).toBe(true);
  });

  it.todo(
    'an agent task’s tick sends it to Needs review (LEANS-ON MP-4-15’s transition, SL08 U19)',
  );
});

describe('MP-5-9 the hover box holds timer, add subtask and a door with its in-app or external mark', () => {
  it('holds add subtask and the door, marked in-app, and no timer the page cannot start', async () => {
    const { board } = await open();
    const box = one(board, 'tr[data-row="open"] .cbd__routes--pop');
    expect(box?.querySelector('[data-route="subtask"]')?.getAttribute('href')).toBe(
      '/tasks/TSK-open#add-subtask',
    );
    const door = box?.querySelector<HTMLElement>('[data-route="door"]');
    expect(door?.getAttribute('href')).toBe('/tasks/TSK-open');
    expect(door?.dataset['mark']).toBe('in-app');
    expect(box?.querySelector('[data-route="timer"]')).toBeNull();
  });

  it('holds the timer when the page can start one, and pressing it starts it for that row', async () => {
    const { board, calls } = await open({}, true);
    await board.click('tr[data-row="open"] [data-route="timer"]');
    expect(calls.timers).toStrictEqual(['open']);
  });
});

describe('MP-5-9 open the task beside the board', () => {
  it('a plain click opens the task after 260ms; a double-click in that time does not', async () => {
    vi.useFakeTimers();
    try {
      const { board, calls } = await open();
      await fire(
        one(board, NAME('open')),
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      expect(calls.opens).toStrictEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(calls.opens).toStrictEqual(['open']);
      await fire(
        one(board, NAME('done')),
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await dbl(board, 'done');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(calls.opens).toStrictEqual(['open']);
    } finally {
      vi.useRealTimers();
    }
  });
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('MP-5-9 the row’s commands from the Projects screen', () => {
  it('the tick calls task.complete and a rename task.update, each at the row’s revision', async () => {
    const sent: { readonly url: string; readonly body: Readonly<Record<string, unknown>> }[] = [];
    const task = {
      id: TASK_ID,
      key: 'TSK-1',
      title: 'Task TSK-1',
      state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
      assignee: null,
      due: null,
      priority: null,
      completedAt: null,
      revision: 7,
      rank: { number: null, score: null, calc: 'not ranked: missing ease' },
      stage: null,
      clientSet: false,
      statePosition: 2000,
      awaitingDecision: false,
    };
    const fetch = ((url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Readonly<Record<string, unknown>>;
      sent.push({ url: String(url), body });
      return Promise.resolve(
        String(url).includes('task/board') || String(url).includes('task.board')
          ? json({ ok: true, tasks: [task], changedAt: null, viewer: null, withheld: 0 })
          : json({ ok: true, recordId: TASK_ID, revision: 8, detail: {} }),
      );
    }) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      token: 'a-token',
      fetch,
      newOperationId: () => 'operation-1',
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
    mounted = await mount(<Projects client={client} grantKey="alpha:ada" />);
    await settle();
    await mounted.click(`tr[data-row="${TASK_ID}"] input.cbd__tick`);
    await settle();
    await fire(
      one(mounted, NAME(TASK_ID)),
      new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
    );
    await mounted.type(RENAME(TASK_ID), 'Renamed on the board');
    await key(mounted, TASK_ID, 'Enter');
    await settle();
    const commands = sent
      .filter((each) => !each.url.includes('board'))
      .map((each) => [each.url.split('/').slice(-2).join('/'), each.body]);
    expect(commands).toStrictEqual([
      ['task/complete', { recordId: TASK_ID, operationId: 'operation-1', expectedRevision: 7 }],
      [
        'task/update',
        {
          recordId: TASK_ID,
          fields: { title: 'Renamed on the board' },
          operationId: 'operation-1',
          expectedRevision: 7,
        },
      ],
    ]);
  });
});
