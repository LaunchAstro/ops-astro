// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #2344: the Tasks page shows every task, a board-less one with no assignee
// included. The page reads the tasks on no board (`board: null`) and opens on
// the viewer's own (P-11), so a task nobody holds was out of sight (T-6). The
// All tasks chip, beside the viewer's, turns every filter off and is on while
// none is; its count is every task the reader was handed.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow } from '../../packages/ui/src/board/projects.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { ROUTES, matchRoute } from '../../apps/web/src/routes.ts';
import { SECTIONS } from '../../apps/web/src/manifest.ts';
import { PANELS } from '../../apps/web/src/panels.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const NOW = new Date(2026, 9, 29, 10, 0);
const ME = '11111111-1111-4111-8111-111111111111';

const row = (id: string, over: Partial<ProjectRow> = {}): ProjectRow => ({
  id,
  key: `T-${id}`,
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
  row('5', { assignee: { id: ME, name: 'Nathan', agent: false }, category: 'SEO' }),
  row('6'),
];

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const drawn = (board: Mounted): readonly string[] =>
  board.all('tbody tr[data-row]').map((each) => (each as HTMLElement).dataset['row'] ?? '');
const one = (board: Mounted, selector: string): Element | null =>
  board.host.querySelector(selector);

const ALL = '.cbd__preset[data-preset="all"]';
/** A shift-click: the board's stacking gesture, which adds a preset to the filters on. */
const stack = async (board: Mounted, selector: string): Promise<void> => {
  const target = one(board, selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
  });
};
const VIEWER = '.cbd__preset--viewer';

describe('#2344 the All tasks chip shows every task', () => {
  const open = async (): Promise<Mounted> => {
    mounted = await mount(
      <ProjectsBoard
        rows={ROWS}
        withheld={0}
        stages={[]}
        href={(each) => `/task/${each.key}`}
        now={NOW}
        width={1400}
        viewport={1480}
        viewer={ME}
      />,
    );
    return mounted;
  };

  it('sits first, counts every task, and is off while the viewer preset is on', async () => {
    const board = await open();
    const chips = board.all('.cbd__preset').map((chip) => (chip as HTMLElement).dataset['preset']);
    expect(chips[0]).toBe('all');
    expect(one(board, ALL)?.textContent).toContain('All tasks');
    expect(one(board, `${ALL} .cbd__count`)?.textContent).toBe('2');
    expect(one(board, ALL)?.classList.contains('is-on')).toBe(false);
    expect(drawn(board)).toStrictEqual(['5']);
  });

  it('pressing it turns every filter off and draws the task nobody holds', async () => {
    const board = await open();
    await stack(board, '.cbd__preset--cat[data-preset="cat-seo"]');
    expect(one(board, ALL)?.classList.contains('is-on')).toBe(false);
    await board.click(ALL);
    expect(one(board, ALL)?.classList.contains('is-on')).toBe(true);
    expect(one(board, VIEWER)?.classList.contains('is-on')).toBe(false);
    expect(drawn(board)).toStrictEqual(['5', '6']);
  });

  it('a stacked press turns every filter off too', async () => {
    const board = await open();
    await stack(board, ALL);
    expect(drawn(board)).toStrictEqual(['5', '6']);
  });
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('#2344 a task on no board with no assignee shows on the Tasks page', () => {
  it('is read with the tasks on no board and drawn once All tasks is pressed', async () => {
    const t6 = {
      id: '66666666-6666-4666-8666-666666666666',
      key: 'T-6',
      title: 'Put together the cover',
      state: { id: 's-6', key: 'active', label: 'Active', machineCategory: 'started' },
      assignee: null,
      due: null,
      priority: null,
      completedAt: null,
      revision: 1,
      rank: { number: null, score: null, calc: 'not ranked: missing ease' },
      stage: null,
      clientSet: false,
      statePosition: 2000,
      awaitingDecision: false,
    };
    const sent: unknown[] = [];
    const fetch = ((_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')));
      return Promise.resolve(
        json({ ok: true, tasks: [t6], changedAt: null, viewer: ME, withheld: 0 }),
      );
    }) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
      newOperationId: () => 'operation-1',
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
    mounted = await mount(<Projects navigate={() => {}} client={client} grantKey="alpha:nathan" />);
    await settle();
    expect(sent).toContainEqual(expect.objectContaining({ board: null }));
    expect(drawn(mounted)).toStrictEqual([]);
    await mounted.click(ALL);
    await settle();
    expect(drawn(mounted)).toStrictEqual([t6.id]);
  });
});

describe('#2344 the section reads Tasks at its old address', () => {
  it('names the page, its rail section, its tab and the dock tab Tasks', () => {
    expect(section().label).toBe('Tasks');
    expect(section().tabs[0]?.label).toBe('Tasks');
    expect(ROUTES['agency:projects-board'].title).toBe('Tasks');
    expect(PANELS.todos?.label).toBe('Tasks');
  });

  it('keeps /projects/ as the page’s address, so an old link still lands', () => {
    expect(matchRoute('/projects/')?.id).toBe('agency:projects-board');
    expect(section().path).toBe('/projects/');
  });
});

function section() {
  const found = SECTIONS.find((each) => each.namespace === 'agency' && each.id === 'projects');
  if (found === undefined) throw new Error('no agency projects section');
  return found;
}
