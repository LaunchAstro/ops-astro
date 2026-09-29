// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's group banners (MP-5-11, B-21). Stub: the order the
// rows arrive in, and no reason.

import type { ProjectRow } from './project-row.ts';

export function statusOrder(rows: readonly ProjectRow[]): readonly string[] {
  return [...new Set(rows.map((row) => row.status))];
}

export function groupReason(_rows: readonly ProjectRow[]): string | null {
  return null;
}
