// SPDX-License-Identifier: AGPL-3.0-only
//
// Tasks written the way `task.create` will write them, once T1f exists.
//
// The command envelope — the operation identity, the expected revision, the
// audit event — is T1f's. What this fixture composes is the part T1e owns: the
// server-side derivations that stand between a request body and a row. It
// writes `data` and nothing else, because a slot is the trigger's to fill, and
// it goes through the application role inside the tenancy wrapper.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  deriveSource,
  nextTaskKey,
  planTaskPlacement,
  type TaskPlacementRequest,
} from '../../packages/core-records/src/tasks/placement.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';
import type { InstalledTaskSpine } from '../../packages/core-records/src/tasks/install.ts';

export interface CreateTaskRequest extends TaskPlacementRequest {
  readonly title: string;
  readonly stateKey?: string;
}

/** The identifier of a task created through the derivations, or the refusal. */
export async function createTask(
  tx: TenantQuery,
  spine: InstalledTaskSpine,
  request: CreateTaskRequest,
): Promise<string> {
  const placement = await planTaskPlacement(tx, spine.taskTypeId, request);
  if (isRecordsRefusal(placement)) {
    throw new Error(`createTask: refused ${placement.code} (${placement.names.join(', ')})`);
  }
  const id = randomUUID();
  const stateId = request.stateKey === undefined ? undefined : spine.stateIds[request.stateKey];
  await tx.query(
    `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
    [
      tx.businessId,
      id,
      spine.taskTypeId,
      {
        title: request.title,
        key: await nextTaskKey(tx, spine.taskTypeId),
        source: deriveSource('person', 'app'),
        ...(stateId === undefined ? {} : { state: stateId }),
        ...(placement.board === null ? {} : { board: placement.board }),
        ...(placement.boardSection === null ? {} : { board_section: placement.boardSection }),
        board_rank: placement.boardRank,
        ...(request.parentId === null ? {} : { parent: request.parentId }),
      },
    ],
  );
  return id;
}

export async function readSlots(
  tx: TenantQuery,
  recordId: string,
): Promise<Record<string, unknown>> {
  const rows = await tx.query<Record<string, unknown>>(
    `select * from records where business_id = $1 and id = $2`,
    [tx.businessId, recordId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`readSlots: ${recordId} is not there`);
  return row;
}
