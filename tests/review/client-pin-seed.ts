// SPDX-License-Identifier: AGPL-3.0-only
//
// A client pin for the change-request proofs (C57, #2016). Client review is off
// (`CLIENT_REVIEW_OPEN`, `review-pin.ts`, DECISIONS 43), so `review.pin_comment` refuses a pin
// for the client. A change request is filed only from a client pin, so its proofs make a team
// pin through the command and rewrite that row as the open switch would have written it: the
// audience and the comment type `client`, nothing else.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

export async function asClientPin(
  admin: Pick<AdminConnection, 'execute'>,
  business: string,
  commentId: string,
): Promise<void> {
  const rows = await admin.execute<{ readonly id: string }>(
    `update public.records
        set data = data || '{"audience":"client","comment_type":"client"}'::jsonb
      where business_id = $1 and id = $2 and data ? 'anchor'
      returning id`,
    [business, commentId],
  );
  if (rows.length !== 1) throw new Error(`asClientPin: no pin ${commentId} in ${business}`);
}
