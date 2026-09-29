// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8: the Projects board drawn on the board machine, its nine columns and
// their cells, on synthetic rows (never a real client). Values the product
// does not store yet (client names, estimates, actuals, comment counts) are
// drawn here from the rows handed in; the screen's mapping from `task.board`
// is the last suite.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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
  client: 'Acme Advocacy',
  assignee: null,
  due: null,
  completed: false,
  stage: null,
  status: 'In progress',
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
  ...over,
});

const ROWS: readonly ProjectRow[] = [
  row('quiet', {
    name: 'Logo refresh',
    rank: {
      number: 2,
      calc: 'impact 7 × confidence 9 × ease 10 × priority 1 × age 1 = 630 · derived',
    },
    assignee: { name: 'Ada Park', agent: false },
    due: '2026-07-18T00:00:00.000Z',
    stage: 'Build',
    estimate: { kind: 'time', minutes: 240 },
    actual: { kind: 'time', minutes: 120 },
  }),
  row('waiting', {
    name: 'Landing page copy',
    client: 'Beta Bakery',
    rank: {
      number: 1,
      calc: 'impact 10 × confidence 10 × ease 9 × priority 1 × age 1 = 900 · derived',
    },
    due: '2026-09-30T00:00:00.000Z',
    estimate: { kind: 'tokens', tokens: 100_000, by: 'the planner' },
    actual: { kind: 'tokens', tokens: 122_000, runs: 3 },
    comments: { client: 2, mentions: 1, latest: '2026-09-28' },
  }),
  row('unranked', { name: 'Admin audit', client: 'Beta Bakery' }),
];

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const open = async (props: Partial<Parameters<typeof ProjectsBoard>[0]> = {}): Promise<Mounted> => {
  mounted = await mount(
    <ProjectsBoard
      rows={ROWS}
      withheld={0}
      stages={['Brief', 'Build', 'Launch']}
      href={(each) => `/tasks/${each.key}`}
      now={NOW}
      width={1400}
      viewport={1480}
      {...props}
    />,
  );
  return mounted;
};

const heads = (board: Mounted): readonly (string | null)[] =>
  board.all('thead th').map((th) => (th as HTMLElement).dataset['key'] ?? null);
const order = (board: Mounted): readonly (string | null)[] =>
  board.all('tbody tr[data-row]').map((tr) => (tr as HTMLElement).dataset['row'] ?? null);
const cellOf = (board: Mounted, id: string, key: string): Element | null =>
  board.find(`tbody tr[data-row="${id}"] td[data-key="${key}"]`);

describe('MP-5-8 nine columns, drawn', () => {
  it('draws the nine heads in order at 1480, with no State column', async () => {
    const board = await open();
    expect(heads(board)).toStrictEqual([
      'rank',
      'name',
      'comments',
      'client',
      'assignee',
      'due',
      'stage',
      'estimate',
      'actual',
    ]);
    expect(board.text()).not.toMatch(/\bState\b/u);
  });

  it('opens on the work order, the arrow under Rank (P-20)', async () => {
    const board = await open();
    expect(order(board)).toStrictEqual(['waiting', 'quiet', 'unranked']);
    expect(board.find('thead th[data-key="rank"]')?.getAttribute('aria-sort')).toBe('ascending');
  });
});

describe('MP-5-8 every cell as specified, drawn', () => {
  it('rank: the figure titled with its calc line, the same as its task page (MP-4-9); a titled dash when not ranked', async () => {
    const board = await open();
    const ranked = cellOf(board, 'quiet', 'rank')?.querySelector('[title]');
    expect([ranked?.textContent, ranked?.getAttribute('title')]).toStrictEqual([
      '2',
      'impact 7 × confidence 9 × ease 10 × priority 1 × age 1 = 630 · derived',
    ]);
    const dash = cellOf(board, 'unranked', 'rank')?.querySelector('[title]');
    expect([dash?.textContent, dash?.getAttribute('title')]).toStrictEqual([
      '—',
      'Not ranked yet — it is in the review queue',
    ]);
  });

  it('due words and tones, the stage chip, time and token estimates', async () => {
    const board = await open();
    expect(cellOf(board, 'quiet', 'due')?.textContent).toBe('Overdue · 18 Jul');
    expect(cellOf(board, 'quiet', 'due')?.querySelector('[data-tone="overdue"]')).not.toBeNull();
    expect(cellOf(board, 'waiting', 'due')?.textContent).toBe('Today');
    expect(cellOf(board, 'unranked', 'due')?.textContent).toBe('—');
    expect(cellOf(board, 'quiet', 'stage')?.querySelector('.cbd__chip')?.textContent).toBe('Build');
    expect(cellOf(board, 'quiet', 'estimate')?.textContent).toBe('4h');
    const tokens = cellOf(board, 'waiting', 'estimate');
    expect(tokens?.textContent).toBe('100ktokens');
    expect(tokens?.querySelector('[title]')?.getAttribute('title')).toBe(
      'estimated by the planner · computed from the skills, never typed',
    );
  });

  it('the burn bar fills actual over estimate, and an overrun prints the actual in the danger tone', async () => {
    const board = await open();
    const half = cellOf(board, 'quiet', 'actual')?.querySelector('.brn');
    expect(half?.getAttribute('title')).toBe('2h of 4h');
    expect((half?.querySelector('.brn__fill') as HTMLElement | null)?.style.width).toBe('50%');
    const over = cellOf(board, 'waiting', 'actual')?.querySelector('.brn');
    expect(over?.classList.contains('is-over')).toBe(true);
    expect(over?.textContent).toContain('122k');
    expect(over?.getAttribute('title')).toBe('122k of 100k — 22k over · 3 runs');
    expect(cellOf(board, 'unranked', 'actual')?.textContent).toBe('—');
  });
});

describe('MP-5-8 comment badge count and door, drawn', () => {
  it('shows the exact count, is empty at 0, and opens the task on its comments without sorting', async () => {
    const board = await open();
    const badge = cellOf(board, 'waiting', 'comments')?.querySelector('a.cbd__cmt');
    expect(badge?.textContent).toContain('3');
    expect(badge?.getAttribute('href')).toBe('/tasks/TSK-waiting#comments');
    expect(badge?.getAttribute('aria-label')).toContain('2 from the client · 1 mentioning you');
    expect(cellOf(board, 'quiet', 'comments')?.textContent).toBe('');
    // eslint-disable-next-line require-await -- act's async form flushes the click's effects
    await act(async () => {
      badge?.addEventListener('click', (event) => {
        event.preventDefault();
      });
      badge?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(board.find('thead th[data-key="comments"]')?.getAttribute('aria-sort')).toBe('none');
    expect(order(board)).toStrictEqual(['waiting', 'quiet', 'unranked']);
  });

  it('the Client comments head sorts waiting rows to the top, first press descending, and never filters', async () => {
    const board = await open({
      rows: [ROWS[2], ROWS[0], ROWS[1]].filter((each): each is ProjectRow => each !== undefined),
    });
    await board.click('thead th[data-key="comments"] button');
    expect(board.find('thead th[data-key="comments"]')?.getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(order(board)[0]).toBe('waiting');
    expect(order(board)).toHaveLength(3);
  });
});

describe('MP-5-8 client column drops for one client, drawn', () => {
  it('drops the Client column when one client filter is on', async () => {
    const board = await open({ address: 'f=client:beta-bakery' });
    expect(heads(board)).not.toContain('client');
    expect(order(board)).toStrictEqual(['waiting', 'unranked']);
  });

  it('drops it when every row shown is one client’s', async () => {
    const board = await open({
      rows: [ROWS[0]].filter((each): each is ProjectRow => each !== undefined),
    });
    expect(heads(board)).toContain('name');
    expect(heads(board)).not.toContain('client');
  });
});

describe('CS-5.10 open the row’s record, drawn', () => {
  it('the name is a link to the task, reachable by keyboard', async () => {
    const board = await open();
    const link = cellOf(board, 'quiet', 'name')?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/tasks/TSK-quiet');
    expect(link?.textContent).toBe('Logo refresh');
  });
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('MP-5-8 column read-back, drawn from task.board', () => {
  it('draws the stored rank with its calc line, the stage and the due from the read', async () => {
    const tasks = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        key: 'TSK-7',
        title: 'Booking form',
        state: { id: 's1', key: 'active', label: 'In progress', machineCategory: 'started' },
        assignee: { personId: 'p-1', name: 'Noah Reid' },
        due: '2026-10-04T00:00:00.000Z',
        priority: null,
        completedAt: null,
        revision: 2,
        rank: {
          number: 4,
          score: 320,
          calc: 'impact 8 × confidence 5 × ease 8 × priority 1 × age 1 = 320 · derived',
        },
        stage: 'Launch',
        clientSet: true,
      },
    ];
    const fetch = (() =>
      Promise.resolve(
        json({
          ok: true,
          tasks,
          changedAt: null,
          withheld: 0,
        }),
      )) as unknown as typeof globalThis.fetch;
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
    const rank = mounted.find('tbody tr td[data-key="rank"] [title]');
    expect([rank?.textContent, rank?.getAttribute('title')]).toStrictEqual([
      '4',
      'impact 8 × confidence 5 × ease 8 × priority 1 × age 1 = 320 · derived',
    ]);
    expect(mounted.find('tbody tr td[data-key="stage"] .cbd__chip')?.textContent).toBe('Launch');
    expect(mounted.find('tbody tr td[data-key="assignee"]')?.textContent).toContain('Noah Reid');
    expect(mounted.find('tbody tr td[data-key="name"] a')?.getAttribute('href')).toContain('TSK-7');
  });
});
