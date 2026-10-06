// SPDX-License-Identifier: AGPL-3.0-only
//
// A client named in a client-visible comment is told by email (AW-07b
// mention). The comment's own transaction raised their `client_comment`
// item (`raiseMentions`); once it has committed, each such item goes through
// the timing path's `emailAtOnce`, which reads the client's choice for client
// comments: instant sends now (the broker's one send, which rechecks that the
// client can read the task and holds a confirmed address), the daily batch
// leaves it for the worker's daily pass, and off never mails it. A mention of
// someone who cannot read the comment never gets this far: the comment is
// refused at compose time and nothing is raised (`writeTaskComment`).
//
// Only the comment's client items are read, by the comment's id, in the
// caller's business: a staff mention waits in the inbox for the delivery
// worker's own timing, and nothing of another comment or business is sent.

import type { BusinessId, Database } from '../../core-records/src/index.ts';
import { emailAtOnce, type EmailTiming } from './email-timing.ts';

type AtOnceResult = Awaited<ReturnType<typeof emailAtOnce>>;

/** Tell each client a committed comment named, on their timing; one result per item, in raised order. */
export async function tellCommentClients(
  database: Database,
  businessId: BusinessId,
  commentId: string,
  timing: EmailTiming,
): Promise<readonly AtOnceResult[]> {
  const items = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly id: string }>(
        `select id from public.inbox_items
          where business_id = $1 and fact_kind = 'record' and fact_id = $2
            and reason = 'client_comment' and work_state = 'open'
          order by raised_at, id`,
        [tx.businessId, commentId],
      ),
  );
  const results: AtOnceResult[] = [];
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop -- one send at a time, each its own attempt
    results.push(await emailAtOnce(database, businessId, item.id, timing));
  }
  return results;
}
