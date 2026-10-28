// SPDX-License-Identifier: AGPL-3.0-only
//
// C57's bodies for the identifier cases (#2016), kept apart from C35's for the line cap.

import { randomUUID } from 'node:crypto';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import type { Caller } from './cast.ts';

/**
 * A change request of another business's on its review (C57), for the identifier cases: its
 * task stands in for the pin, as the restricted-calls seed's does.
 */
export async function seedForeignChangeRequest(
  admin: Pick<AdminConnection, 'execute'>,
  business: string,
  review: { readonly reviewId: string; readonly taskId: string },
  by: Pick<Caller, 'actorId' | 'personId'>,
): Promise<string> {
  const id = randomUUID();
  await admin.execute(
    `insert into public.review_change_requests
       (business_id, id, review_id, comment_id, task_id, request_text, proposed_by_actor_id,
        proposed_by_person_id)
     values ($1, $2, $3, $4, $4, 'a change', $5, $6)`,
    [business, id, review.reviewId, review.taskId, by.actorId, by.personId],
  );
  return id;
}
