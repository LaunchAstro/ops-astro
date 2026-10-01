// SPDX-License-Identifier: AGPL-3.0-only
//
// What a board hands the board machine (U09 and U13), and the plain glyphs its
// chips and heads draw. Its own module so the machine's parts share them
// without importing one another.

import type { ReactNode } from 'react';
import type { ColumnSpec, ColumnWidths, Facet, Preset, RowMode } from '../board/types.ts';

export const STACK_TIP = ' · shift-click to add it to what is already on';

/** Plain glyphs until the kit's icon set lands (SL03); the label names the head. */
export const GLYPH: Readonly<Record<string, string>> = {
  building: '▦',
  calendar: '◷',
  comment: '◌',
  person: '◍',
  tag: '◈',
};

export interface BoardMode<Row> extends RowMode<Row> {
  /** The alternative surface, over the same narrowed rows; without one, the table narrows. */
  readonly render?: (rows: readonly Row[]) => ReactNode;
  /** A live count on the mode's chip, and what it says (P-10). */
  readonly badge?: { readonly count: number; readonly title: string };
  /** What the table says when the mode leaves no row. */
  readonly empty?: { readonly title: string; readonly description: string };
}

export interface BoardMachineProps<Row> {
  /** The rows the viewer may read, as the board's read answered them. */
  readonly rows: readonly Row[];
  /** How many rows the viewer's grants withheld, never which (B-22). */
  readonly withheld: number;
  readonly columns: readonly ColumnSpec<Row>[];
  readonly facets: readonly Facet<Row>[];
  readonly presets?: readonly Preset[];
  readonly modes?: readonly BoardMode<Row>[];
  /**
   * Rows grouped under banners in this order; sorting happens within groups.
   * `reason` is the quiet words after a banner's heading, from its own rows.
   */
  readonly groups?: {
    readonly order: readonly string[];
    readonly of: (row: Row) => string;
    readonly reason?: (rows: readonly Row[]) => string | null;
  };
  readonly rowKey: (row: Row) => string;
  readonly cell: (row: Row, key: string) => ReactNode;
  /** What a free word is matched against. */
  readonly hay: (row: Row) => string;
  /** The row's name, as the typeahead suggests it. */
  readonly name: (row: Row) => string;
  readonly noun: string;
  readonly empty: { readonly title: string; readonly description: string };
  /** The address's query the board opens on (B-06, C6). */
  readonly address?: string;
  /** Told the new query whenever the view changes. */
  readonly onAddress?: (address: string) => void;
  /** The card's width in pixels; measured when absent. */
  readonly width?: number;
  /** The window's width, for `hideBelow`; read from the window when absent. */
  readonly viewport?: number;
  /** The person's saved column widths the board opens on (MP-5-6); null is the defaults. */
  readonly widths?: ColumnWidths | null;
  /** Told the widths to keep whenever a drag, an arrow step, a reset or an undo changes them. */
  readonly onWidths?: (widths: ColumnWidths | null) => void;
  /** When the newest record in scope changed (MP-5-7, P-07); null or absent draws no stamp. */
  readonly changedAt?: string | null;
  /** The time the stamp counts from; the clock when absent. */
  readonly now?: Date;
  /** The page's title-row slot the command bar is drawn into (MP-5-7, B-04). */
  readonly bar?: HTMLElement | null;
  /** Another panel is showing: the board and its bar are withdrawn (D-03). */
  readonly hidden?: boolean;
}
