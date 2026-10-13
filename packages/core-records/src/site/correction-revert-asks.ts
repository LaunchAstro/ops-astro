// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's revert ask (20261013110000): the configured approver's one ask that a
// live correction be reverted. Its id is what the worker's revert step names.
// The command judges who may ask, under the correction's lock; this writes the
// row, once per correction.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';

export interface RevertAsk {
  readonly id: string;
  readonly correctionId: string;
}

export interface RevertAskWrite {
  readonly correctionId: string;
  readonly actorId: string;
  readonly personId: string;
}

/**
 * Store the ask on a correction the caller has locked and judged, or
 * undefined when the correction carries an ask already.
 */
export async function insertRevertAsk(
  tx: TenantQuery,
  write: RevertAskWrite,
): Promise<RevertAsk | undefined> {
  const rows = await tx.query<{ readonly id: string; readonly correction_id: string }>(
    `insert into public.live_correction_revert_asks
       (business_id, id, correction_id, asked_by_actor_id, asked_by_person_id)
     values ($1, $2, $3, $4, $5)
     on conflict (business_id, correction_id) do nothing
     returning id, correction_id`,
    [tx.businessId, randomUUID(), write.correctionId, write.actorId, write.personId],
  );
  const [row] = rows;
  return row === undefined ? undefined : { id: row.id, correctionId: row.correction_id };
}
