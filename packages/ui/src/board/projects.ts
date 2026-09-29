// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's columns (MP-5-8): a stub, red before the columns.

/* eslint-disable no-unused-vars -- a stub: the next commit draws the columns */

import type { ColumnSpec } from './types.ts';

export type Estimate =
  | { readonly kind: 'time'; readonly minutes: number }
  | { readonly kind: 'tokens'; readonly tokens: number; readonly by: string };

export type Actual =
  | { readonly kind: 'time'; readonly minutes: number }
  | { readonly kind: 'tokens'; readonly tokens: number; readonly runs: number };

export interface ProjectRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly rank: { readonly number: number | null; readonly calc: string };
  readonly starred: boolean;
  readonly client: string | null;
  readonly assignee: { readonly name: string; readonly agent: boolean } | null;
  readonly due: string | null;
  readonly completed: boolean;
  readonly stage: string | null;
  readonly status: string;
  readonly estimate: Estimate | null;
  readonly actual: Actual | null;
  readonly comments: {
    readonly client: number;
    readonly mentions: number;
    readonly latest: string | null;
  };
}

export const PROJECT_COLUMNS: readonly ColumnSpec<ProjectRow>[] = [];

export const projectColumns = (_: {
  readonly stages: readonly string[];
  readonly rows?: readonly ProjectRow[];
  readonly clientFilters?: number;
}): readonly ColumnSpec<ProjectRow>[] => PROJECT_COLUMNS;

export const rankCell = (_: ProjectRow): { readonly text: string; readonly title: string } => ({
  text: '',
  title: '',
});

export const dueWords = (
  _iso: string | null,
  _completed: boolean,
  _now: Date,
): { readonly text: string; readonly tone: 'overdue' | 'today' | 'plain' | 'none' } => ({
  text: '',
  tone: 'none',
});

export const estimateWords = (
  _: Estimate | null,
): { readonly text: string; readonly tokens: boolean; readonly title?: string } => ({
  text: '',
  tokens: false,
});

export interface Burn {
  readonly fill: number | null;
  readonly over: boolean;
  readonly figure: string | null;
  readonly title: string;
}

export const burnOf = (_e: Estimate | null, _a: Actual | null): Burn => ({
  fill: null,
  over: false,
  figure: null,
  title: '',
});

export const commentBadge = (
  _: ProjectRow,
): { readonly count: number; readonly title: string } | null => ({ count: 0, title: '' });
