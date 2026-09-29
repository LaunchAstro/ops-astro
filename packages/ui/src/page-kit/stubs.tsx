// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement, ReactNode } from 'react';
export interface Tip {
  readonly page: string;
  readonly id: string;
  readonly text: string;
}
export interface TipPreferences {
  readonly dismissed: readonly string[];
  readonly tipsOff: boolean;
  readonly dismiss: (key: string) => void;
}
export const tipKey = (_tip: Tip): string => '';
export const visibleTip = (_tip: Tip, _p: TipPreferences): boolean => true;
export const SectionTip = (_props: {
  tip: Tip;
  preferences: TipPreferences;
}): ReactElement | null => null;
export const sectionIndex = (_n: number): string => '';
export const SectionHead = (_props: {
  index: string;
  title: string;
  right?: ReactNode;
  tip?: Tip;
  preferences?: TipPreferences;
}): ReactElement | null => null;
export const Layer = (_props: {
  order: number;
  title: string;
  count?: number;
  open?: boolean;
  children?: ReactNode;
}): ReactElement | null => null;
export const Hint = (_props: {
  text: string;
  action?: { label: string; run: () => void };
}): ReactElement | null => null;
export const StatRow = (_props: { columns: number; children?: ReactNode }): ReactElement | null =>
  null;
export const Stat = (_props: {
  label: string;
  value: number;
  suffix?: string;
  of?: number;
  track?: boolean;
  term?: string;
  delta?: { value: number; period: string };
}): ReactElement | null => null;
export interface TableColumn<R> {
  readonly id: string;
  readonly label: string;
  readonly value: (row: R) => string | number | null;
  readonly numeric?: boolean;
}
export interface SortState {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}
export const sortRows = <R,>(
  rows: readonly R[],
  _c: readonly TableColumn<R>[],
  _s?: SortState,
): readonly R[] => rows;
export const nextSort = (_s: SortState | undefined, _c: string): SortState | undefined => undefined;
export const DataTable = <R,>(_props: {
  label: string;
  columns: readonly TableColumn<R>[];
  rows: readonly R[];
  rowKey: (row: R) => string;
}): ReactElement | null => null;
