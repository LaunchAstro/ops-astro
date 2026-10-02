// SPDX-License-Identifier: AGPL-3.0-only
//
// The board model's fixes for REVIEW-BATCH #305 findings 4, 5, 14 and 15,
// beside the reviewer's proofs: an earlier slugged facet id fails closed,
// names with the address's own characters round-trip, category chips stay
// apart, Clear all survives a reload, a width for a column not drawn cannot
// be changed, and a punctuated custom stage still sorts after the vocabulary.
// Synthetic rows only.

import { describe, expect, it } from 'vitest';
import { readView, writeView } from '../../packages/ui/src/board/address.ts';
import { narrowRows } from '../../packages/ui/src/board/filters.ts';
import { initialMachine, reduceBoard } from '../../packages/ui/src/board/machine.ts';
import { clientFiltersIn, projectFacets } from '../../packages/ui/src/board/project-facets.ts';
import {
  openWithViewer,
  projectPresets,
  REVIEW_MODE,
} from '../../packages/ui/src/board/project-presets.ts';
import { projectColumns, type ProjectRow } from '../../packages/ui/src/board/projects.ts';
import { nextSort, sortRows } from '../../packages/ui/src/board/sort.ts';
import type { BoardContext } from '../../packages/ui/src/board/types.ts';

const NOW = new Date(2026, 8, 30, 10, 0);
const ME = '11111111-1111-4111-8111-111111111111';

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
  row('a', { client: 'Smith & Co', category: 'Smith & Co' }),
  row('b', { client: 'Smith Co', category: 'Smith Co' }),
  row('c', { client: 'Jones, Lee 100%', assignee: { id: ME, name: 'Sam Reed', agent: false } }),
];

const CONTEXT: BoardContext<ProjectRow> = {
  facets: projectFacets(ROWS, NOW, ME),
  columns: [],
  presets: projectPresets(ROWS, ME),
  modes: [REVIEW_MODE],
};

const hay = (one: ProjectRow): string => one.name;
const shown = (ids: readonly string[]): readonly string[] =>
  narrowRows(ROWS, { ids, text: [] }, CONTEXT.facets, hay).map((one) => one.id);

describe('REVIEW-BATCH #305 4: facet ids', () => {
  it('an address saved with an earlier slugged id is dropped and hides no column', () => {
    const view = readView('f=client:smith-co,category:smith-co', CONTEXT);
    expect(view.ids).toStrictEqual([]);
    expect(clientFiltersIn('f=client:smith-co')).toBe(0);
  });

  it('a client name with a comma and a percent sign round-trips through the address', () => {
    const facet = CONTEXT.facets.find((one) => one.label === 'Jones, Lee 100%');
    expect(facet).toBeDefined();
    const id = facet?.id ?? '';
    const back = readView(writeView({ ...initialMachine().view, ids: [id] }), CONTEXT);
    expect(back.ids).toStrictEqual([id]);
    expect(shown(back.ids)).toStrictEqual(['c']);
    expect(clientFiltersIn(writeView(back))).toBe(1);
  });

  it('two categories whose words match get two chips, each narrowing to its own rows', () => {
    const chips = CONTEXT.presets.filter((one) => one.variant === 'cat');
    expect(chips.map((chip) => chip.id)).toStrictEqual(['cat-smith-co', 'cat-smith-co-2']);
    expect(chips.map((chip) => shown(chip.facetIds))).toStrictEqual([['a'], ['b']]);
  });
});

describe('REVIEW-BATCH #305 5: the viewer preset after a reload', () => {
  it('Clear all, then a reload, keeps every filter off', () => {
    const opened = initialMachine(readView(openWithViewer('', ME), CONTEXT));
    expect(opened.view.ids).toStrictEqual([`assignee:${ME}`]);
    const cleared = reduceBoard(opened, { type: 'clear' }, CONTEXT).view;
    const reloaded = readView(openWithViewer(writeView(cleared), ME), CONTEXT);
    expect(reloaded.ids).toStrictEqual([]);
  });
});

describe('REVIEW-BATCH #305 14: widths of columns not drawn', () => {
  it('a resize that changes the width of a column the board does not draw is refused', () => {
    const columns = projectColumns({ stages: [], clientFilters: 1 });
    const context: BoardContext<ProjectRow> = { facets: [], columns, presets: [], modes: [] };
    const machine = initialMachine({
      ...initialMachine().view,
      widths: { name: 300, client: 150 },
    });
    const moved = reduceBoard(
      machine,
      { type: 'resize', key: 'name', widths: { name: 320, client: 170 } },
      context,
    );
    expect(moved).toBe(machine);
  });
});

describe('REVIEW-BATCH #305 15: stages outside the vocabulary', () => {
  it('a stage starting with punctuation still sorts after the vocabulary, by its words', () => {
    const columns = projectColumns({ stages: ['Brief', 'Build'] });
    const stage = columns.find((column) => column.key === 'stage');
    if (stage === undefined) throw new Error('no stage column');
    const rows = [
      row('hold', { stage: '(Hold)' }),
      row('build', { stage: 'Build' }),
      row('extra', { stage: 'Extra' }),
      row('brief', { stage: 'Brief' }),
    ];
    const order = sortRows(rows, nextSort(null, stage), columns).map((one) => one.id);
    expect(order).toStrictEqual(['brief', 'build', 'hold', 'extra']);
  });
});
