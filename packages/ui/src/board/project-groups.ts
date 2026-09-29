// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's group banners (MP-5-11, B-21, CS-5.11). The groups are
// the rows' statuses in the workflow's order: the position each row's state
// carries from the board's read, so a reordered workflow reorders the board
// and the order the rows arrive in never does. A banner's waiting reasons are
// the distinct reasons of its own rows, so a group whose rows disagree says
// each, and a group with none says nothing.

import type { ProjectRow } from './project-row.ts';

const placed = (position: number | null | undefined): position is number =>
  typeof position === 'number' && Number.isFinite(position);

/**
 * The statuses of these rows, in the workflow's order. A status with no known
 * position goes after every placed one, in the order first seen, never
 * dropped. A status no row is in draws no group.
 */
export function statusOrder(rows: readonly ProjectRow[]): readonly string[] {
  const at = new Map<string, number | null>();
  for (const row of rows) {
    if (!at.has(row.status)) at.set(row.status, null);
    if (placed(row.statusPosition) && at.get(row.status) === null) {
      at.set(row.status, row.statusPosition);
    }
  }
  const seen = [...at.keys()];
  const known = seen.filter((status) => placed(at.get(status)));
  const unknown = seen.filter((status) => !placed(at.get(status)));
  return [...known.toSorted((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0)), ...unknown];
}

/** The group's waiting reasons after its heading, each once; null for none. */
export function groupReason(rows: readonly ProjectRow[]): string | null {
  const reasons = [...new Set(rows.flatMap((row) => (row.waitReason ? [row.waitReason] : [])))];
  return reasons.length === 0 ? null : reasons.join(' · ');
}
