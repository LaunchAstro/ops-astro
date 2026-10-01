// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-14, red proof: `widthsAfterDrag` merges the drag over the
// person's earlier widths ({...previous, ...now}), so widths saved while the
// Client column was drawn keep a 'client' key after one client filter drops
// that column (P-23). The machine refuses a resize naming a column it does not
// draw, so every drag after a client filter records nothing: resize is dead.
// Fixed when that drag records one step.

import { describe, expect, it } from 'vitest';
import {
  initialMachine,
  layoutColumns,
  reduceBoard,
  widthsAfterDrag,
  type BoardContext,
  type ColumnWidths,
} from '../../packages/ui/src/board/index.ts';
import { projectColumns, type ProjectRow } from '../../packages/ui/src/board/projects.ts';

const STAGES = ['Brief', 'Build', 'Launch'];
const SIZE = { viewport: 1480, available: 1200 };

describe('REVIEW-2C1-14 column resize after a client filter', () => {
  it('REVIEW-2C1-14: with widths saved while Client was drawn, a drag after one client filter drops Client records one step', () => {
    // The person's widths, from a drag while every column was drawn.
    const all = projectColumns({ stages: STAGES });
    const saved = widthsAfterDrag(all, layoutColumns(all, SIZE), null, 'name', 40);
    expect(saved).not.toBeNull();
    expect(Object.keys(saved as ColumnWidths)).toContain('client');

    // One client filter on: the Client column is gone (P-23).
    const columns = projectColumns({ stages: STAGES, clientFilters: 1 });
    expect(columns.map((column) => column.key)).not.toContain('client');
    const context: BoardContext<ProjectRow> = { facets: [], columns, presets: [], modes: [] };
    const machine = initialMachine({
      ids: [],
      text: [],
      sort: null,
      mode: null,
      widths: saved,
    });
    const layout = layoutColumns(columns, SIZE, saved);
    const widths = widthsAfterDrag(columns, layout, saved, 'name', 30);
    expect(widths).not.toBeNull();

    const dragged = reduceBoard(
      machine,
      { type: 'resize', key: 'name', widths: widths as ColumnWidths },
      context,
    );
    expect(dragged.history.past, 'the drag records one step').toHaveLength(1);
    expect(dragged.history.past[0]?.label).toBe('resize Task name');
  });
});
