// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 (#429): the live change record's *changes since* read (CS-15.19, API-4).

import type { TenantQuery } from '../tenancy/database.ts';
import type { Subject } from '../authority/grants.ts';

/** One task that changed after the point; nothing about what changed. */
export interface TaskChange {
  readonly kind: 'task';
  readonly id: string;
  readonly changedAt: Date;
}

export interface ChangesSince {
  /** Hand this back as the next call's point. */
  readonly point: string;
  readonly changes: readonly TaskChange[];
}

export async function changesSince(
  tx: TenantQuery,
  _subjects: readonly Subject[],
  _point: string | null,
): Promise<ChangesSince | 'POINT_INVALID'> {
  return await Promise.resolve({ point: tx.businessId === '' ? '' : '0', changes: [] });
}
