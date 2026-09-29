// SPDX-License-Identifier: AGPL-3.0-only
//
// The column width model (MP-5-1, B-18, CS-5.9): hide what the viewport drops,
// renormalise the survivors' shares, lift any column under its floor with the
// slack of the others, and when the floors alone exceed the card, give the
// table their sum so it scrolls inside the card and the page never scrolls
// sideways. A column under its label width goes tight: the head hides its
// words and centres its icon, and the cells follow (clipped, never ellipsed,
// in `4-board.css`).

import type { ColumnSpec, Layout } from './types.ts';

/** The columns a viewport this wide draws, in their declared order. */
export function visibleColumns<Row>(
  columns: readonly ColumnSpec<Row>[],
  viewport: number,
): readonly ColumnSpec<Row>[] {
  return columns.filter((column) => column.hideBelow === undefined || viewport >= column.hideBelow);
}

/**
 * Shares to percentages with the pixel floors honoured. A column below its
 * floor is lifted to it and the deficit comes off the columns with slack, in
 * proportion to that slack. The caller guarantees the floors fit `available`.
 */
export function resolveShares<Row>(
  columns: readonly ColumnSpec<Row>[],
  available: number,
): readonly number[] {
  const total = columns.reduce((sum, column) => sum + column.share, 0) || 1;
  let widths = columns.map((column) => (column.share / total) * available);
  for (let pass = 0; pass < 4; pass += 1) {
    const short = columns.map((column, index) => Math.max(0, column.min - (widths[index] ?? 0)));
    const deficit = short.reduce((sum, value) => sum + value, 0);
    if (deficit < 0.01) break;
    const slack = columns.map((column, index) => Math.max(0, (widths[index] ?? 0) - column.min));
    const room = slack.reduce((sum, value) => sum + value, 0);
    if (room < 0.01) {
      widths = columns.map((column) => column.min);
      break;
    }
    widths = widths.map(
      (px, index) => px + (short[index] ?? 0) - ((slack[index] ?? 0) / room) * deficit,
    );
  }
  const sum = widths.reduce((total_, px) => total_ + px, 0) || 1;
  return widths.map((px) => (px / sum) * 100);
}

/** Lay the board's columns out for one viewport and one card width. */
export function layoutColumns<Row>(
  columns: readonly ColumnSpec<Row>[],
  size: { readonly viewport: number; readonly available: number },
): Layout {
  const shown = visibleColumns(columns, size.viewport);
  const floors = shown.reduce((sum, column) => sum + column.min, 0);
  const overflow = floors > size.available;
  const width = overflow ? floors : size.available;
  const shares = resolveShares(shown, width);
  return {
    columns: shown.map((column, index) => {
      const pct = shares[index] ?? 0;
      const px = (pct / 100) * width;
      const tight = column.iconOnly === true || px < column.labelWidth;
      return { key: column.key, pct, px, tight, align: tight ? 'center' : column.align };
    }),
    tableWidth: overflow ? floors : null,
  };
}
