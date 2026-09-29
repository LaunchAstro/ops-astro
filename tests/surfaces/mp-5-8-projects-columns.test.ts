// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8: the Projects board's nine columns and the words their cells draw
// (BOARDS P-20 to P-28, P-36), pure. The board hands these to the machine;
// the machine's sort cycle, floors and tight heads are U09's and proved there.

import { describe, expect, it } from 'vitest';
import {
  PROJECT_COLUMNS,
  burnOf,
  commentBadge,
  dueWords,
  estimateWords,
  projectColumns,
  rankCell,
  type ProjectRow,
} from '../../packages/ui/src/board/projects.ts';
import { nextSort, sortRows } from '../../packages/ui/src/board/sort.ts';

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
  status: 'To do',
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
  ...over,
});

// A due is stored as the picked day at midnight UTC (task/DetailsForm.tsx).
const iso = (y: number, m: number, d: number) =>
  `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00.000Z`;

const ranked = (number: number) => ({ number, calc: `calc for #${String(number)}` });

const columns = projectColumns({ stages: ['Brief', 'Build', 'Launch'] });
const specOf = (key: string) => {
  const spec = columns.find((column) => column.key === key);
  if (spec === undefined) throw new Error(`no ${key} column`);
  return spec;
};
const order = (rows: readonly ProjectRow[], key: string, presses = 1): readonly string[] => {
  let sort = null as ReturnType<typeof nextSort>;
  for (let press = 0; press < presses; press += 1) sort = nextSort(sort, specOf(key));
  return sortRows(rows, sort, columns).map((each) => each.id);
};

describe('MP-5-8 nine columns', () => {
  it('draws the nine columns in the mockup’s order, with no State column and a Client comments column (R72)', () => {
    expect(PROJECT_COLUMNS.map((column) => column.key)).toStrictEqual([
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
    expect(PROJECT_COLUMNS.map((column) => column.label)).not.toContain('State');
    expect(specOf('comments').label).toBe('Client comments');
  });

  it('declares each column’s share, floor and label width as the mockup draws it', () => {
    const declared = PROJECT_COLUMNS.map((c) => [c.key, c.share, c.min, c.hideBelow ?? null]);
    expect(declared).toStrictEqual([
      ['rank', 2, 44, null],
      ['name', 28.5, 180, null],
      ['comments', 2, 44, null],
      ['client', 13.5, 110, null],
      ['assignee', 11, 52, null],
      ['due', 12, 118, null],
      ['stage', 8.45, 84, 900],
      ['estimate', 2, 48, 1280],
      ['actual', 9.5, 104, 1280],
    ]);
    expect(specOf('rank').iconOnly).toBe(true);
    expect(specOf('comments').iconOnly).toBe(true);
  });
});

describe('MP-5-8 every cell as specified', () => {
  it('rank: the figure, or a dash titled as in the review queue; ranked rows title their calc line', () => {
    expect(rankCell(row('a', { rank: ranked(3) }))).toStrictEqual({
      text: '3',
      title: 'calc for #3',
    });
    expect(rankCell(row('b'))).toStrictEqual({
      text: '—',
      title: 'Not ranked yet — it is in the review queue',
    });
  });

  it('due words: overdue with its day, Today, a plain day, never overdue once complete, a dash for none', () => {
    expect(dueWords(iso(2026, 7, 18), false, NOW)).toStrictEqual({
      text: 'Overdue · 18 Jul',
      tone: 'overdue',
    });
    expect(dueWords(iso(2026, 9, 30), false, NOW)).toStrictEqual({ text: 'Today', tone: 'today' });
    expect(dueWords(iso(2026, 10, 4), false, NOW)).toStrictEqual({ text: '4 Oct', tone: 'plain' });
    expect(dueWords(iso(2026, 7, 18), true, NOW)).toStrictEqual({ text: '18 Jul', tone: 'plain' });
    expect(dueWords(null, false, NOW)).toStrictEqual({ text: '—', tone: 'none' });
  });

  it('estimates: time in hours or days, tokens as a figure never typed', () => {
    expect(estimateWords({ kind: 'time', minutes: 240 })).toStrictEqual({
      text: '4h',
      tokens: false,
    });
    expect(estimateWords({ kind: 'time', minutes: 960 })).toStrictEqual({
      text: '2d',
      tokens: false,
    });
    expect(estimateWords({ kind: 'time', minutes: 45 })).toStrictEqual({
      text: '45m',
      tokens: false,
    });
    expect(estimateWords({ kind: 'tokens', tokens: 120_000, by: 'the planner' })).toStrictEqual({
      text: '120k',
      tokens: true,
      title: 'estimated by the planner · computed from the skills, never typed',
    });
    expect(estimateWords(null)).toStrictEqual({ text: '—', tokens: false });
  });
});

describe('MP-5-8 every cell as specified: the burn bar', () => {
  it('burn bar: fills actual over estimate, says the overrun, and without an estimate is the figure alone', () => {
    const time = { kind: 'time', minutes: 240 } as const;
    expect(burnOf(time, { kind: 'time', minutes: 120 })).toStrictEqual({
      fill: 0.5,
      over: false,
      figure: null,
      title: '2h of 4h',
    });
    expect(burnOf(time, { kind: 'time', minutes: 300 })).toStrictEqual({
      fill: 1,
      over: true,
      figure: '5h',
      title: '5h of 4h — 1h over',
    });
    expect(
      burnOf(
        { kind: 'tokens', tokens: 100_000, by: 'x' },
        { kind: 'tokens', tokens: 122_000, runs: 3 },
      ),
    ).toStrictEqual({
      fill: 1,
      over: true,
      figure: '122k',
      title: '122k of 100k — 22k over · 3 runs',
    });
    expect(burnOf(null, { kind: 'time', minutes: 90 })).toStrictEqual({
      fill: null,
      over: false,
      figure: '1.5h',
      title: '1.5h',
    });
    expect(burnOf(null, null)).toStrictEqual({ fill: null, over: false, figure: '—', title: '' });
  });
});

describe('MP-5-8 comment badge count and door', () => {
  it('counts exactly the unanswered client signals and open mentions, and is empty at 0', () => {
    expect(
      commentBadge(row('a', { comments: { client: 2, mentions: 1, latest: '2026-09-28' } })),
    ).toStrictEqual({
      count: 3,
      title: '2 from the client · 1 mentioning you · latest 28 Sep — open the task on its comments',
    });
    expect(commentBadge(row('b'))).toBeNull();
  });
});

describe('MP-5-8 client column drops for one client', () => {
  const two = [row('a', { client: 'Acme' }), row('b', { client: 'Beta' })];
  it('keeps the Client column while two clients are shown', () => {
    expect(projectColumns({ stages: [], rows: two, clientFilters: 0 }).map((c) => c.key)).toContain(
      'client',
    );
  });
  it('drops it when every row shown is one client’s, or exactly one client filter is on', () => {
    const one = [row('a', { client: 'Acme' }), row('b', { client: 'Acme' })];
    expect(
      projectColumns({ stages: [], rows: one, clientFilters: 0 }).map((c) => c.key),
    ).not.toContain('client');
    expect(
      projectColumns({ stages: [], rows: two, clientFilters: 1 }).map((c) => c.key),
    ).not.toContain('client');
    expect(projectColumns({ stages: [], rows: two, clientFilters: 2 }).map((c) => c.key)).toContain(
      'client',
    );
  });
});

describe('MP-5-8 work order sort', () => {
  it('puts the signed-in person’s starred rows first, then ranked rows by #N, then unranked (P-20)', () => {
    const rows = [
      row('unranked'),
      row('r2', { rank: ranked(2) }),
      row('starred', { rank: ranked(5), starred: true }),
      row('r1', { rank: ranked(1) }),
    ];
    expect(order(rows, 'rank')).toStrictEqual(['starred', 'r1', 'r2', 'unranked']);
    expect(nextSort(null, specOf('rank'))).toStrictEqual({ key: 'rank', dir: 'asc' });
  });
});

describe('CS-5.10 sort by each column’s natural order', () => {
  it('names A to Z, stages in stage order, due earliest first with blanks last', () => {
    const rows = [
      row('b', { name: 'Beta', stage: 'Launch', due: '2026-10-09T00:00:00.000Z' }),
      row('a', { name: 'alpha', stage: 'Brief', due: null }),
      row('c', { name: 'Gamma', stage: 'Build', due: '2026-10-02T00:00:00.000Z' }),
    ];
    expect(order(rows, 'name')).toStrictEqual(['a', 'b', 'c']);
    expect(order(rows, 'stage')).toStrictEqual(['a', 'c', 'b']);
    expect(order(rows, 'due')).toStrictEqual(['c', 'b', 'a']);
  });

  it('assignees by short name, time estimates by minutes with token rows after, actual by burn first press descending', () => {
    const rows = [
      row('t', {
        estimate: { kind: 'tokens', tokens: 5, by: 'x' },
        assignee: { name: 'Zed Ames', agent: false },
      }),
      row('long', {
        estimate: { kind: 'time', minutes: 600 },
        actual: { kind: 'time', minutes: 300 },
        assignee: { name: 'Ada Park', agent: false },
      }),
      row('short', {
        estimate: { kind: 'time', minutes: 60 },
        actual: { kind: 'time', minutes: 90 },
      }),
    ];
    expect(order(rows, 'assignee')).toStrictEqual(['long', 't', 'short']);
    expect(order(rows, 'estimate')).toStrictEqual(['short', 'long', 't']);
    expect(order(rows, 'actual')).toStrictEqual(['short', 'long', 't']);
  });
});

describe('CS-5.10 waiting to the top', () => {
  it('the Client comments head sorts, first press descending, and never filters', () => {
    const rows = [
      row('quiet'),
      row('one', { comments: { client: 1, mentions: 0, latest: null } }),
      row('three', { comments: { client: 2, mentions: 1, latest: null } }),
    ];
    expect(order(rows, 'comments')).toStrictEqual(['three', 'one', 'quiet']);
    expect(order(rows, 'comments', 2)).toStrictEqual(['one', 'three', 'quiet']);
    expect(order(rows, 'comments', 3)).toStrictEqual(['quiet', 'one', 'three']);
  });
});
