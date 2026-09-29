// SPDX-License-Identifier: AGPL-3.0-only
// STUB (red): MP-5-6 widths, not yet written.

import type { ColumnSpec, ColumnWidths, Layout } from './types.ts';

export const GRIP_STEP = 0;
export const GRIP_STEP_LARGE = 0;
export const WIDTHS_PREFERENCE = '';

export function resizeAt(
  _columns: readonly { readonly min: number }[],
  px: readonly number[],
  _index: number,
  _dx: number,
): readonly number[] {
  return px;
}

export function widthsAfterDrag<Row>(
  _columns: readonly ColumnSpec<Row>[],
  _layout: Layout,
  _previous: ColumnWidths | null,
  _key: string,
  _dx: number,
): ColumnWidths | null {
  return null;
}

export function widthsFromPreference<Row>(
  _board: string,
  _columns: readonly ColumnSpec<Row>[],
  _stored: unknown,
): ColumnWidths | null {
  return null;
}

export function widthsToPreference(
  _board: string,
  _stored: unknown,
  _widths: ColumnWidths | null,
): Readonly<Record<string, number>> {
  return {};
}
