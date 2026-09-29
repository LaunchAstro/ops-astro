// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-12: the Projects board's viewer preset, category chips and Review
// mode, pure. The viewer preset narrows to the signed-in person's own tasks
// and is on at load agency-wide; a category chip is offered only for a
// category some row in scope has, flagged (never counted) when a client or a
// mention waits there; the Review mode's count is the rows waiting on the
// viewer's decision, and opening it drops every assignee filter (P-10,
// `gateRule`). Synthetic rows only.

import { describe, expect, it } from 'vitest';
import { initialMachine, reduceBoard } from '../../packages/ui/src/board/machine.ts';
import { projectFacets } from '../../packages/ui/src/board/project-facets.ts';
import {
  openWithViewer,
  projectPresets,
  reviewBadge,
  REVIEW_MODE,
} from '../../packages/ui/src/board/project-presets.ts';
import type { ProjectRow } from '../../packages/ui/src/board/projects.ts';
import type { BoardContext } from '../../packages/ui/src/board/types.ts';

const NOW = new Date(2026, 8, 30, 10, 0);
const ME = '11111111-1111-4111-8111-111111111111';
const ADA = '22222222-2222-4222-8222-222222222222';
const ADA_TWO = '33333333-3333-4333-8333-333333333333';

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
  row('mine', { assignee: { id: ME, name: 'Sam Reed', agent: false }, category: 'SEO' }),
  row('ada', {
    assignee: { id: ADA, name: 'Ada Park', agent: false },
    category: 'Branding',
    comments: { client: 1, mentions: 0, latest: null },
    awaitingDecision: true,
  }),
  row('ada-two', {
    assignee: { id: ADA_TWO, name: 'Ada Park', agent: false },
    category: 'SEO',
    awaitingDecision: true,
  }),
  row('loose', { category: 'Admin', comments: { client: 0, mentions: 2, latest: null } }),
];

const contextOf = (rows: readonly ProjectRow[]): BoardContext<ProjectRow> => ({
  facets: projectFacets(rows, NOW, ME),
  columns: [],
  presets: projectPresets(rows, ME),
  modes: [REVIEW_MODE],
});

describe('MP-5-12 the viewer preset is on by default for the signed-in person', () => {
  it('is a preset over the viewer’s own person, named as the rows name them', () => {
    const viewer = projectPresets(ROWS, ME).find((preset) => preset.variant === 'viewer');
    expect(viewer).toStrictEqual({
      id: `who-${ME}`,
      label: 'Sam Reed',
      variant: 'viewer',
      facetIds: [`assignee:${ME}`],
    });
  });

  it('keys the assignee filters on the person, never the name', () => {
    const ids = projectFacets(ROWS, NOW, ME)
      .filter((facet) => facet.kind === 'Assignee')
      .map((facet) => facet.id);
    expect(ids).toStrictEqual([`assignee:${ADA}`, `assignee:${ADA_TWO}`, `assignee:${ME}`]);
  });

  it('still offers the viewer’s filter when no row is theirs, so the preset is on and empty', () => {
    const others = ROWS.filter((each) => each.id !== 'mine');
    const facet = projectFacets(others, NOW, ME).find((one) => one.id === `assignee:${ME}`);
    expect(facet?.test(ROWS[0] as ProjectRow)).toBe(true);
    expect(projectPresets(others, ME)[0]?.label).toBe('Mine');
  });

  it('is on at load agency-wide, and an address already naming filters is left alone', () => {
    expect(openWithViewer('sort=rank.asc', ME)).toBe(`sort=rank.asc&f=assignee%3A${ME}`);
    expect(openWithViewer(`f=status%3Aactive`, ME)).toBe('f=status%3Aactive');
    expect(openWithViewer('', null)).toBe('');
  });

  it('a plain click on it alone clears it', () => {
    const context = contextOf(ROWS);
    const on = initialMachine({
      ids: [`assignee:${ME}`],
      text: [],
      sort: null,
      mode: null,
      widths: null,
    });
    const off = reduceBoard(on, { type: 'preset', id: `who-${ME}`, stack: false }, context);
    expect(off.view.ids).toStrictEqual([]);
  });
});

describe('MP-5-12 category chips are flagged by an unanswered client signal or open mention, with no count', () => {
  it('draws one uncounted chip per category, flagged only where a client or a mention waits', () => {
    const chips = projectPresets(ROWS, ME).filter((preset) => preset.variant === 'cat');
    expect(chips.map((chip) => [chip.label, chip.uncounted, chip.flag ?? null])).toStrictEqual([
      ['Admin', true, 'A client or a mention is waiting here'],
      ['Branding', true, 'A client or a mention is waiting here'],
      ['SEO', true, null],
    ]);
    expect(chips.map((chip) => chip.facetIds)).toStrictEqual([
      ['category:admin'],
      ['category:branding'],
      ['category:seo'],
    ]);
  });

  it('only categories present in scope appear as chips (P-13, M-04)', () => {
    const scoped = ROWS.filter((each) => each.category === 'SEO');
    const labels = projectPresets(scoped, ME)
      .filter((preset) => preset.variant === 'cat')
      .map((preset) => preset.label);
    expect(labels).toStrictEqual(['SEO']);
    expect(
      projectPresets([row('bare')], ME).filter((preset) => preset.variant === 'cat'),
    ).toStrictEqual([]);
  });
});

describe('MP-5-12 Review mode drops assignee filters', () => {
  it('opening Review drops every assignee filter and keeps the rest', () => {
    const context = contextOf(ROWS);
    const start = initialMachine({
      ids: [`assignee:${ME}`, `assignee:${ADA}`, 'category:seo'],
      text: ['copy'],
      sort: null,
      mode: null,
      widths: null,
    });
    const review = reduceBoard(start, { type: 'mode', id: 'review' }, context);
    expect(review.view).toMatchObject({ mode: 'review', ids: ['category:seo'], text: ['copy'] });
    const back = reduceBoard(review, { type: 'mode', id: 'review' }, context);
    expect(back.view).toMatchObject({ mode: null, ids: ['category:seo'] });
    expect(reduceBoard(back, { type: 'undo' }, context).view.mode).toBe('review');
  });

  it('counts the rows waiting on the viewer’s decision, live from the rows handed in', () => {
    expect(reviewBadge(ROWS)).toStrictEqual({ count: 2, title: '2 waiting on your gate' });
    expect(reviewBadge([row('one', { awaitingDecision: true })]).title).toBe(
      '1 waiting on your gate',
    );
    expect(reviewBadge([row('quiet')])).toStrictEqual({
      count: 0,
      title: 'Nothing waiting on your gate',
    });
    expect(REVIEW_MODE.narrow?.(row('w', { awaitingDecision: true }))).toBe(true);
    expect(REVIEW_MODE.narrow?.(row('q'))).toBe(false);
  });
});
