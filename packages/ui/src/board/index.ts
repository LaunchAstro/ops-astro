// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub for the red run: the real types, empty behaviour.
/* eslint-disable */
import type * as T from './types.ts';
export type * from './types.ts';
export const HISTORY_CAP: number = 0;
const view: T.BoardView = { ids: [], text: [], sort: null, mode: null, widths: null };
export const initialMachine = (): T.MachineState => ({
  view,
  history: { past: [], future: [] },
});
export const visibleColumns = <Row>(
  c: readonly T.ColumnSpec<Row>[],
  _v: number,
): readonly T.ColumnSpec<Row>[] => c;
export const resolveShares = <Row>(
  _c: readonly T.ColumnSpec<Row>[],
  _a: number,
): readonly number[] => [];
export const layoutColumns = <Row>(
  _c: readonly T.ColumnSpec<Row>[],
  _o: { viewport: number; available: number },
): T.Layout => ({ columns: [], tableWidth: null });
export const nextSort = <Row>(_s: T.SortState | null, _c: T.ColumnSpec<Row>): T.SortState | null =>
  null;
export const sortRows = <Row>(
  r: readonly Row[],
  _s: T.SortState | null,
  _c: readonly T.ColumnSpec<Row>[],
): readonly Row[] => r;
export const pressFacet = (
  ids: readonly string[],
  _id: string,
  _stack: boolean,
): readonly string[] => ids;
export const narrowRows = <Row>(
  r: readonly Row[],
  _f: T.Filters,
  _x: readonly T.Facet<Row>[],
  _h: (row: Row) => string,
): readonly Row[] => r;
export const parseQuery = <Row>(_raw: string, _f: readonly T.Facet<Row>[]): T.Filters => ({
  ids: [],
  text: [],
});
export const readingLine = <Row>(
  _f: T.Filters,
  _x: readonly T.Facet<Row>[],
  _n: number,
  _w: number,
): string => '';
export const presetCount = <Row>(
  _r: readonly Row[],
  _p: T.Preset,
  _f: readonly T.Facet<Row>[],
  _h: (row: Row) => string,
): number => 0;
export const reduceBoard = <Row>(
  s: T.MachineState,
  _a: T.BoardAction,
  _c: T.BoardContext<Row>,
): T.MachineState => s;
export const suggest = <Row>(_o: {
  q: string;
  facets: readonly T.Facet<Row>[];
  names: readonly string[];
  noun: string;
  have: T.Filters;
}): readonly T.SuggestionGroup[] => [];
export const writeView = (_v: T.BoardView): string => '';
export const readView = <Row>(_s: string, _c: T.BoardContext<Row>): T.BoardView => view;
