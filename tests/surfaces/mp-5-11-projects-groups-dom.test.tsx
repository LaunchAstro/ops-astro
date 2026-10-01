// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-11: the Projects board's group banners drawn, on synthetic rows. The
// banners come in the workflow's order, each a plain heading with its rows'
// waiting reasons after it (no colour, no count, B-21), and the sort applies
// within groups. The last suite draws the order from `task.board` through
// the Projects screen.

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

// Handed in with the last group first, so first-seen would be backwards.
const ROWS: readonly ProjectRow[] = [
  row('done', { name: 'Brochure', status: 'Complete', statusPosition: 5000, completed: true }),
  row('held', { name: 'Signage', status: 'On hold', statusPosition: 4000 }),
  row('wait-b', {
    name: 'Menu copy',
    status: 'Waiting on client',
    statusPosition: 3000,
    waitReason: 'approval',
  }),
  row('go-b', { name: 'Zebra banner', status: 'Active', statusPosition: 2000 }),
  row('wait-a', {
    name: 'Alt text',
    status: 'Waiting on client',
    statusPosition: 3000,
    waitReason: 'client reply',
  }),
  row('go-a', { name: 'Apple page', status: 'Active', statusPosition: 2000 }),
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
      stages={[]}
      href={(each) => `/tasks/${each.key}`}
      now={NOW}
      width={1400}
      viewport={1480}
      {...props}
    />,
  );
  return mounted;
};

const banners = (board: Mounted): readonly string[] =>
  board.all('tbody tr.cbd__grp .cbd__grpb').map((each) => each.firstChild?.textContent ?? '');

/** Each banner and the rows under it, in the order drawn. */
const layout = (board: Mounted): readonly (readonly string[])[] => {
  const groups: string[][] = [];
  for (const tr of board.all('tbody tr')) {
    const el = tr as HTMLElement;
    if (el.classList.contains('cbd__grp')) groups.push([el.textContent]);
    else groups.at(-1)?.push(el.dataset['row'] ?? '');
  }
  return groups;
};

describe("MP-5-11 groups in the status vocabulary's order (not first-seen), drawn", () => {
  it('draws the banners in the workflow’s order, whatever order the rows came in', async () => {
    const board = await open();
    expect(banners(board)).toStrictEqual(['Active', 'Waiting on client', 'On hold', 'Complete']);
  });

  it('a banner is a plain heading: no count, no colour, not a control', async () => {
    const board = await open();
    const banner = board.find('tbody tr.cbd__grp');
    expect(banner?.textContent).not.toMatch(/\d/u);
    expect(banner?.querySelector('button, a, [data-tone], [role="button"]')).toBeNull();
  });
});

describe('MP-5-11 waiting reasons after the heading, drawn', () => {
  it('draws the group’s reasons after its heading, each once, as its rows are drawn', async () => {
    const board = await open();
    const waiting = board
      .all('tbody tr.cbd__grp')
      .find((tr) => tr.textContent.startsWith('Waiting on client'));
    const heading = waiting?.querySelector('.cbd__grpb');
    expect(heading?.firstChild?.textContent).toBe('Waiting on client');
    // Both rows are unranked, so the work order keeps them as handed in.
    expect(heading?.querySelector('.cbd__grpr')?.textContent).toBe('approval · client reply');
  });

  it('says nothing after a heading whose rows have no reason', async () => {
    const board = await open();
    const active = board.all('tbody tr.cbd__grp').find((tr) => tr.textContent === 'Active');
    expect(active?.querySelector('.cbd__grpr')).toBeNull();
  });
});

describe('MP-5-11 sort applies within groups, drawn', () => {
  it('sorts each group’s rows by the chosen column and keeps the banners in the workflow’s order', async () => {
    const board = await open({ address: 'sort=name.asc' });
    expect(layout(board).map((group) => group[0])).toStrictEqual([
      'Active',
      'Waiting on clientclient reply · approval',
      'On hold',
      'Complete',
    ]);
    expect(layout(board).map((group) => group.slice(1))).toStrictEqual([
      ['go-a', 'go-b'],
      ['wait-a', 'wait-b'],
      ['held'],
      ['done'],
    ]);
  });

  it('turning the sort round turns each group round, never the groups', async () => {
    const board = await open({ address: 'sort=name.desc' });
    expect(layout(board).map((group) => group.slice(1))).toStrictEqual([
      ['go-b', 'go-a'],
      ['wait-b', 'wait-a'],
      ['held'],
      ['done'],
    ]);
  });
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const task = (
  id: string,
  key: string,
  label: string,
  position: number,
  waitReason: string | null = null,
) => ({
  id,
  key,
  title: `Task ${key}`,
  state: { id: `s-${key}`, key: label.toLowerCase(), label, machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  statePosition: position,
  waitReason,
  awaitingDecision: false,
});

/** The Projects screen, mounted over a task.board answer of these tasks. */
const screen = async (tasks: readonly ReturnType<typeof task>[]): Promise<Mounted> => {
  const fetch = (() =>
    Promise.resolve(
      json({ ok: true, tasks, changedAt: null, withheld: 0 }),
    )) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  mounted = await mount(<Projects navigate={() => {}} client={client} grantKey="alpha:ada" />);
  await settle();
  return mounted;
};

describe('MP-5-11 groups in the workflow’s order, drawn from task.board', () => {
  it('draws the banners in the positions the read carries, not the order it lists', async () => {
    const board = await screen([
      task('11111111-1111-4111-8111-111111111111', 'TSK-1', 'Complete', 5000),
      task('22222222-2222-4222-8222-222222222222', 'TSK-2', 'Active', 2000),
      task('33333333-3333-4333-8333-333333333333', 'TSK-3', 'Needs review', 1000),
    ]);
    expect(banners(board)).toStrictEqual(['Needs review', 'Active', 'Complete']);
  });
});

describe('MP-5-11 waiting reasons after the heading, drawn from task.board', () => {
  it('prints “approval” after the heading of a group with a run awaiting approval', async () => {
    const board = await screen([
      task('11111111-1111-4111-8111-111111111111', 'TSK-1', 'Waiting on client', 3000),
      task(
        '22222222-2222-4222-8222-222222222222',
        'TSK-2',
        'Waiting on client',
        3000,
        'needs_approval',
      ),
      task('33333333-3333-4333-8333-333333333333', 'TSK-3', 'Active', 2000),
    ]);
    const reasons = board
      .all('tbody tr.cbd__grp .cbd__grpb')
      .map((each) => each.querySelector('.cbd__grpr')?.textContent ?? null);
    expect(banners(board)).toStrictEqual(['Active', 'Waiting on client']);
    expect(reasons).toStrictEqual([null, 'approval']);
  });
});
