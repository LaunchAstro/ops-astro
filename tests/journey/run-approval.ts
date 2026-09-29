// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d: the approval the journey applied, as the run hands it to the command.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

/** The `journey-approval` line for the task's decision. Not built yet. */
export async function approvalLine(
  _admin: AdminConnection,
  _businessId: string,
  _taskId: string,
): Promise<string> {
  return await Promise.resolve('journey-approval {}');
}
