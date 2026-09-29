// SPDX-License-Identifier: AGPL-3.0-only
//
// The board machine's vocabulary (U09: MP-5-1 to MP-5-5). A board is a
// subject handed to one machine, never a new grammar: the Projects board, the
// client's board and the CRM hand it their rows, columns, facets, presets and
// modes, and the machine owns the width model, the sort cycle, the narrowing,
// the reading line, the view history, the typeahead and the address.

/** One column as a board declares it (B-18, DS-COMP-17). */
export interface ColumnSpec<Row> {
  readonly key: string;
  readonly label: string;
  /** Share of the table's width, before floors and hiding. */
  readonly share: number;
  /** Pixel floor: no layout draws the column narrower. */
  readonly min: number;
  /** Below this many pixels the head drops its words and shows its icon. */
  readonly labelWidth: number;
  /** Below this viewport width the column is not drawn at all. */
  readonly hideBelow?: number;
  /** Icon-headed by design at every width, never measured. */
  readonly iconOnly?: boolean;
  /** The glyph a tight head centres; the label stays its accessible name. */
  readonly icon?: string;
  readonly align: 'start' | 'center' | 'end';
  /** The useful first direction; otherwise `desc` for figures, `asc` for words. */
  readonly firstDir?: SortDir;
  /** What the column sorts by. A column without one does not sort. */
  readonly sortValue?: (row: Row) => string | number | null;
}

/** A column as one layout draws it. */
export interface LaidColumn {
  readonly key: string;
  /** Percentage of the table's width. The shares always total 100. */
  readonly pct: number;
  readonly px: number;
  /** Label hidden, icon centred, cells centred and clipped. */
  readonly tight: boolean;
  readonly align: 'start' | 'center' | 'end';
}

export interface Layout {
  readonly columns: readonly LaidColumn[];
  /** Pixel width of the table when the floors exceed the card, else null. */
  readonly tableWidth: number | null;
}

export type SortDir = 'asc' | 'desc';

export interface SortState {
  readonly key: string;
  readonly dir: SortDir;
}

/** One fact of the rows a person can filter by (B-06). */
export interface Facet<Row> {
  readonly id: string;
  /** Same kind ORs, different kinds AND. */
  readonly kind: string;
  readonly label: string;
  /** The words a typed query recognises as this facet. */
  readonly words?: readonly string[];
  readonly test: (row: Row) => boolean;
}

/** A named, counted shortcut over one or more facets (B-07). */
export interface Preset {
  readonly id: string;
  readonly label: string;
  readonly facetIds: readonly string[];
}

/** An alternative surface over the same rows (B-09). */
export interface Mode {
  readonly id: string;
  readonly label: string;
}

export interface Filters {
  readonly ids: readonly string[];
  readonly text: readonly string[];
}

/** Everything a person can change about how the board reads; never a record. */
export interface BoardView extends Filters {
  readonly sort: SortState | null;
  readonly mode: string | null;
  /** The person's column shares after a drag (MP-5-6); null is the defaults. */
  readonly widths: readonly number[] | null;
}

export interface Step {
  readonly label: string;
  readonly view: BoardView;
}

export interface History {
  readonly past: readonly Step[];
  readonly future: readonly Step[];
}

export interface MachineState {
  readonly view: BoardView;
  readonly history: History;
}

export interface BoardContext<Row> {
  readonly facets: readonly Facet<Row>[];
  readonly columns: readonly ColumnSpec<Row>[];
  readonly presets: readonly Preset[];
  readonly modes: readonly Mode[];
}

export type BoardAction =
  | { readonly type: 'press'; readonly id: string; readonly stack: boolean }
  | { readonly type: 'preset'; readonly id: string; readonly stack: boolean }
  | { readonly type: 'mode'; readonly id: string }
  | { readonly type: 'drop'; readonly id: string }
  | { readonly type: 'dropText'; readonly text: string }
  | { readonly type: 'dropLast' }
  | { readonly type: 'clear' }
  | { readonly type: 'commit'; readonly raw: string }
  /** A suggested row name: its words become free words, never facets. */
  | { readonly type: 'phrase'; readonly text: string }
  | { readonly type: 'take'; readonly facetId: string }
  | { readonly type: 'sort'; readonly key: string }
  | { readonly type: 'resize'; readonly widths: readonly number[] }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' };

export interface SuggestionItem {
  readonly kind: string;
  readonly label: string;
  /** Present when taking the item adds a facet. */
  readonly facetId?: string;
  /** Present when taking the item adds a free word. */
  readonly text?: string;
}

export interface SuggestionGroup {
  readonly label: string;
  readonly items: readonly SuggestionItem[];
  /** How many matches the group left out; never a silent cap. */
  readonly more: number;
}
