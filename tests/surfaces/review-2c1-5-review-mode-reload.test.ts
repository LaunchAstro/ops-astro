// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-5, red proof: opening Review drops every assignee filter (P-10),
// so `writeView` writes `mode=review` with no `f`; on reload `openWithViewer`
// sees no `f` and puts the viewer's own assignee filter back, so a gate
// waiting on someone else's task vanishes from Review. Fixed when a reload of
// the Review address shows the same rows as before it. Synthetic rows only.

import { describe, expect, it } from 'vitest';
import { readView, writeView } from '../../packages/ui/src/board/address.ts';
import { narrowRows } from '../../packages/ui/src/board/filters.ts';
import { initialMachine, reduceBoard } from '../../packages/ui/src/board/machine.ts';
import { projectFacets } from '../../packages/ui/src/board/project-facets.ts';
import {
  openWithViewer,
  projectPresets,
  REVIEW_MODE,
} from '../../packages/ui/src/board/project-presets.ts';
import type { ProjectRow } from '../../packages/ui/src/board/projects.ts';
import type { BoardContext, BoardView } from '../../packages/ui/src/board/types.ts';

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

const ROWS: readonly ProjectRow[] = [
  row('mine-gated', {
    assignee: { id: ME, name: 'Sam Reed', agent: false },
    awaitingDecision: true,
  }),
  row('theirs-gated', {
    assignee: { id: ADA, name: 'Ada Park', agent: false },
    awaitingDecision: true,
  }),
  row('mine', { assignee: { id: ME, name: 'Sam Reed', agent: false } }),
];

const CONTEXT: BoardContext<ProjectRow> = {
  facets: projectFacets(ROWS, NOW, ME),
  columns: [],
  presets: projectPresets(ROWS, ME),
  modes: [REVIEW_MODE],
};

const hay = (one: ProjectRow): string => `${one.name} ${one.assignee?.name ?? ''}`;

/** The rows the board draws for a view, as BoardMachine does: filters, then the mode. */
function shown(view: BoardView): readonly string[] {
  const narrowed = narrowRows(ROWS, view, CONTEXT.facets, hay);
  const mode = CONTEXT.modes.find((one) => one.id === view.mode);
  const keep = mode?.narrow;
  return (keep === undefined ? narrowed : narrowed.filter((one) => keep(one))).map((one) => one.id);
}

const reload = (view: BoardView): BoardView =>
  readView(openWithViewer(writeView(view), ME), CONTEXT);

describe('REVIEW-2C1-5 Review mode survives a reload', () => {
  it('REVIEW-2C1-5: after pressing Review, a reload of its address still shows the gate on someone else’s task', () => {
    const opened = initialMachine(readView(openWithViewer('', ME), CONTEXT));
    expect(opened.view.ids).toStrictEqual([`assignee:${ME}`]);
    const review = reduceBoard(opened, { type: 'mode', id: 'review' }, CONTEXT).view;
    expect(shown(review)).toStrictEqual(['mine-gated', 'theirs-gated']);

    const reloaded = reload(review);
    expect(reloaded.mode).toBe('review');
    expect(shown(reloaded), 'theirs-gated still shown after reload').toContain('theirs-gated');
    expect(shown(reloaded)).toStrictEqual(shown(review));
  });
});
