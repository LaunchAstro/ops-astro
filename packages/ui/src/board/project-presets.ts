// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub for MP-5-12's red run.

import type { Preset, RowMode } from './types.ts';
import type { ProjectRow } from './project-row.ts';

export const REVIEW_MODE: RowMode<ProjectRow> = { id: 'review', label: 'Review' };

export function projectPresets(
  _rows: readonly ProjectRow[],
  _viewer: string | null,
): readonly Preset[] {
  return [];
}

export function openWithViewer(address: string, _viewer: string | null): string {
  return address;
}

export function reviewBadge(_rows: readonly ProjectRow[]): {
  readonly count: number;
  readonly title: string;
} {
  return { count: 0, title: '' };
}
