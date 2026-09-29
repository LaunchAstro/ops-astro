// SPDX-License-Identifier: AGPL-3.0-only
//
// A task and its subtasks, read together (MP-4-4, CS-15.19).

import type { TenantQuery } from '../tenancy/database.ts';

export interface FamilyRow {
  readonly id: string;
}

export interface TaskFamily {
  readonly parent: FamilyRow | undefined;
  readonly children: readonly FamilyRow[];
}

export async function readTaskFamily(
  _tx: TenantQuery,
  _taskTypeId: string,
  _parentId: string,
): Promise<TaskFamily> {
  return await Promise.resolve({ parent: undefined, children: [] });
}
