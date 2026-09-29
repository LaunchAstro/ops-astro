// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub for the red run: the real props, nothing drawn.

import type { ReactElement, ReactNode } from 'react';
import type { ColumnSpec, Facet, Mode, Preset } from '../board/types.ts';

export interface BoardMode<Row> extends Mode {
  /** The alternative surface, over the same narrowed rows. */
  readonly render: (rows: readonly Row[]) => ReactNode;
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
  /** Rows grouped under banners in this order; sorting happens within groups. */
  readonly groups?: { readonly order: readonly string[]; readonly of: (row: Row) => string };
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
}

export function BoardMachine<Row>(_props: BoardMachineProps<Row>): ReactElement {
  return <div className="cbd" />;
}
