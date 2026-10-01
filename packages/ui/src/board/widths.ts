// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's column widths (MP-5-6, B-13, B-17, CS-5.6, CS-5.8).
//
// A drag on a column's grip moves width between that column and the columns
// to its right, never below any column's floor, and never moves a column to
// its left. The widths a drag leaves are whole pixels by column key; the
// layout takes them as shares, so they read the same at any card width.
//
// They are kept as one key of the one preference store (MP-2-11,
// `columns.widths`), which maps a column to a width across every board, so
// each board's entries carry its name: `projects.client`. Nothing here reads
// or writes the store; the surface hands the stored value in and is handed
// the value to save.

import type { ColumnSpec, ColumnWidths, Layout } from './types.ts';

/** One arrow press on a focused grip moves this many pixels; Shift, the larger. */
export const GRIP_STEP = 16;
export const GRIP_STEP_LARGE = 64;

/** The one preference store's key for column widths (MP-2-11a). */
export const WIDTHS_PREFERENCE = 'columns.widths';

/** The largest width the store keeps (MP-2-11a: no screen is wider). */
const MOST = 10_000;

/** A width the store keeps: a whole number of pixels above zero. */
export function isWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MOST;
}

/**
 * Move `dx` pixels onto the column at `index` from the columns to its right.
 * Wider: each column to the right gives in proportion to its slack above its
 * floor, and the drag stops when they are all at their floors. Narrower: the
 * next column takes what this one gives, which stops at this one's floor.
 * The total never changes, and the last column has no grip.
 */
export function resizeAt(
  columns: readonly { readonly min: number }[],
  px: readonly number[],
  index: number,
  dx: number,
): readonly number[] {
  const widths = [...px];
  if (index < 0 || index >= columns.length - 1) return widths;
  const floor = (at: number): number => columns[at]?.min ?? 0;
  const at = (i: number): number => widths[i] ?? 0;
  const d = Math.round(dx);
  if (d > 0) {
    // Whole pixels by largest remainder, so the columns give exactly the room
    // and none gives more than its slack.
    const rights = widths.map((_, i) => i).filter((i) => i > index);
    const slack = rights.map((i) => Math.max(0, at(i) - floor(i)));
    const capacity = slack.reduce((sum, value) => sum + value, 0);
    const room = Math.min(d, capacity);
    const exact = slack.map((value) => (capacity > 0 ? (value / capacity) * room : 0));
    const give = exact.map((value) => Math.floor(value));
    let left = room - give.reduce((sum, value) => sum + value, 0);
    const byRemainder = exact
      .map((value, k) => ({ k, rest: value - Math.floor(value) }))
      .toSorted((a, b) => b.rest - a.rest);
    for (const { k } of byRemainder) {
      if (left < 1) break;
      if ((give[k] ?? 0) + 1 <= (slack[k] ?? 0)) {
        give[k] = (give[k] ?? 0) + 1;
        left -= 1;
      }
    }
    rights.forEach((i, k) => {
      widths[i] = at(i) - (give[k] ?? 0);
    });
    widths[index] = at(index) + give.reduce((sum, value) => sum + value, 0);
  } else if (d < 0) {
    const give = Math.min(-d, Math.max(0, at(index) - floor(index)));
    widths[index] = at(index) - give;
    widths[index + 1] = at(index + 1) + give;
  }
  return widths;
}

/**
 * The widths a drag of `dx` on `key`'s grip leaves, from the layout drawn
 * now, merged over the person's earlier widths so a column this viewport
 * hides keeps its own. Null when the drag moves no whole pixel.
 */
export function widthsAfterDrag<Row>(
  columns: readonly ColumnSpec<Row>[],
  layout: Layout,
  previous: ColumnWidths | null,
  key: string,
  dx: number,
): ColumnWidths | null {
  const laid = layout.columns;
  const index = laid.findIndex((column) => column.key === key);
  const floors = laid.map((one) => ({
    min: columns.find((column) => column.key === one.key)?.min ?? 0,
  }));
  const before = laid.map((column) => column.px);
  const after = resizeAt(floors, before, index, dx);
  const whole = (widths: readonly number[]): ColumnWidths =>
    Object.fromEntries(
      laid.map((column, at) => [column.key, Math.max(1, Math.round(widths[at] ?? 0))]),
    );
  const was = whole(before);
  const now = whole(after);
  if (laid.every((column) => was[column.key] === now[column.key])) return null;
  return { ...previous, ...now };
}

const plain = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

/** This board's widths out of the store's value, or null when none is usable. */
export function widthsFromPreference<Row>(
  board: string,
  columns: readonly ColumnSpec<Row>[],
  stored: unknown,
): ColumnWidths | null {
  const saved = plain(stored);
  const found = columns.flatMap((column) => {
    const name = `${board}.${column.key}`;
    const value = Object.hasOwn(saved, name) ? saved[name] : undefined;
    return isWidth(value) ? [[column.key, value] as const] : [];
  });
  return found.length === 0 ? null : Object.fromEntries(found);
}

/**
 * The store's value with this board's widths replaced: every other board's
 * entries kept, this board's dropped, and `widths` (null on a reset) added.
 */
export function widthsToPreference(
  board: string,
  stored: unknown,
  widths: ColumnWidths | null,
): Readonly<Record<string, number>> {
  const prefix = `${board}.`;
  const kept = Object.entries(plain(stored)).filter(
    (entry): entry is [string, number] => !entry[0].startsWith(prefix) && isWidth(entry[1]),
  );
  const mine = Object.entries(widths ?? {}).map(
    ([key, value]) => [`${prefix}${key}`, value] as const,
  );
  return Object.fromEntries([...kept, ...mine]);
}
