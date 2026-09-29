// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-12: the Projects board's viewer preset, category chips and Review
// mode drawn, on synthetic rows. The viewer's chip is on at load and a
// plain click on it alone clears it; a client's board opens with it off.
// Category chips come only for categories in scope, carry no count, and are
// flagged where a client or a mention waits. The Review chip carries the
// live count of tasks waiting on the viewer's decision; pressing it narrows
// the table to them and drops every assignee filter. The last suite draws it
// from `task.board` through the Projects screen.

import { afterEach, describe, expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/projects.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const NOW = new Date(2026, 8, 30, 10, 0);
const ME = '11111111-1111-4111-8111-111111111111';
const ADA = '22222222-2222-4222-8222-222222222222';

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

const mine = { id: ME, name: 'Sam Reed', agent: false };
const ada = { id: ADA, name: 'Ada Park', agent: false };

const ROWS: readonly ProjectRow[] = [
  row('m1', { assignee: mine, category: 'SEO' }),
  row('m2', { assignee: mine, category: 'Branding', awaitingDecision: true }),
  row('a1', {
    assignee: ada,
    category: 'Branding',
    awaitingDecision: true,
    comments: { client: 1, mentions: 0, latest: null },
  }),
  row('a2', { assignee: ada, category: 'SEO' }),
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
      viewer={ME}
      {...props}
    />,
  );
  return mounted;
};

const drawn = (board: Mounted): readonly string[] =>
  board.all('tbody tr[data-row]').map((each) => each.getAttribute('data-row') ?? '');

const VIEWER = `.cbd__preset--viewer`;
const REVIEW = `.cbd__mode[data-mode="review"]`;

describe('MP-5-12 the viewer preset is on by default for the signed-in person', () => {
  it('opens on the viewer’s own tasks, the chip on and named for them', async () => {
    const board = await open();
    expect(board.find(VIEWER)?.classList.contains('is-on')).toBe(true);
    expect(board.find(VIEWER)?.textContent).toContain('Sam Reed');
    expect(drawn(board)).toStrictEqual(['m1', 'm2']);
  });

  it('a plain click on it alone clears it, and every task shows', async () => {
    const board = await open();
    await board.click(VIEWER);
    expect(board.find(VIEWER)?.classList.contains('is-on')).toBe(false);
    expect(drawn(board)).toStrictEqual(['m1', 'm2', 'a1', 'a2']);
  });

  it('is off at load on a client’s board', async () => {
    const board = await open({ viewerOn: false });
    expect(board.find(VIEWER)?.classList.contains('is-on')).toBe(false);
    expect(drawn(board)).toHaveLength(4);
  });
});

describe('MP-5-12 category chips are flagged by an unanswered client signal or open mention, with no count', () => {
  it('draws a chip per category in scope, flagged where a client waits, with no count', async () => {
    const board = await open();
    const chips = board.all('.cbd__preset--cat');
    expect(chips.map((chip) => chip.textContent)).toStrictEqual(['◈Branding', '◈SEO']);
    expect(chips.map((chip) => chip.classList.contains('is-flagged'))).toStrictEqual([true, false]);
    expect(chips[0]?.getAttribute('title')).toContain('A client or a mention is waiting here');
    expect(board.all('.cbd__preset--cat .cbd__count')).toStrictEqual([]);
  });

  it('only categories present in scope appear as chips (P-13, M-04)', async () => {
    const board = await open({ rows: ROWS.filter((each) => each.category === 'SEO') });
    expect(board.all('.cbd__preset--cat').map((chip) => chip.textContent)).toStrictEqual(['◈SEO']);
  });

  it('pressing a chip narrows to the category', async () => {
    const board = await open({ viewerOn: false });
    await board.click('.cbd__preset--cat[data-preset="cat-seo"]');
    expect(drawn(board)).toStrictEqual(['m1', 'a2']);
  });
});

describe('MP-5-12 Review mode drops assignee filters', () => {
  it('carries the live count, and narrows to the tasks waiting on the viewer with the viewer preset dropped', async () => {
    const board = await open();
    expect(board.find(`${REVIEW} .cbd__count`)?.textContent).toBe('2');
    expect(board.find(REVIEW)?.getAttribute('title')).toBe('2 waiting on your gate');
    await board.click(REVIEW);
    expect(board.find(REVIEW)?.getAttribute('aria-pressed')).toBe('true');
    expect(board.find(VIEWER)?.classList.contains('is-on')).toBe(false);
    expect(drawn(board)).toStrictEqual(['m2', 'a1']);
    await board.click(REVIEW);
    expect(drawn(board)).toStrictEqual(['m1', 'm2', 'a1', 'a2']);
  });

  it('with nothing waiting it says so, and the queue draws empty', async () => {
    const board = await open({ rows: ROWS.filter((each) => !each.awaitingDecision) });
    expect(board.find(`${REVIEW} .cbd__count`)?.textContent).toBe('0');
    expect(board.find(REVIEW)?.getAttribute('title')).toBe('Nothing waiting on your gate');
    await board.click(REVIEW);
    expect(drawn(board)).toStrictEqual([]);
    expect(board.text()).toContain('Nothing is waiting for your decision.');
  });
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const task = (id: string, key: string, assignee: string | null, awaitingDecision: boolean) => ({
  id,
  key,
  title: `Task ${key}`,
  state: { id: `s-${key}`, key: 'active', label: 'Active', machineCategory: 'started' },
  assignee:
    assignee === null ? null : { personId: assignee, name: `Person ${assignee.slice(0, 4)}` },
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  statePosition: 2000,
  awaitingDecision,
});

describe('MP-5-12 drawn from task.board through the Projects screen', () => {
  it('opens on the signed-in person’s tasks and counts what waits on their decision', async () => {
    const tasks = [
      task('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'TSK-1', ME, false),
      task('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'TSK-2', ADA, true),
      task('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'TSK-3', null, true),
    ];
    const fetch = (() =>
      Promise.resolve(
        json({ ok: true, tasks, changedAt: null, viewer: ME, withheld: 0 }),
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
    expect(mounted.find(VIEWER)?.classList.contains('is-on')).toBe(true);
    expect(drawn(mounted)).toStrictEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    expect(mounted.find(`${REVIEW} .cbd__count`)?.textContent).toBe('2');
    await mounted.click(REVIEW);
    expect(drawn(mounted)).toStrictEqual([
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]);
  });
});
