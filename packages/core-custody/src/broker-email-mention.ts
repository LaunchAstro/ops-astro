// SPDX-License-Identifier: AGPL-3.0-only
//
// A client named in a client-visible comment is told by email (AW-07b
// mention). The comment's own transaction raised their `client_comment`
// item (`raiseMentions`); once it has committed, each such item goes through
// the broker's one send, `sendInboxEmail`, which rechecks that the client can
// read the task now and that they hold a confirmed address. A mention of
// someone who cannot read the comment never gets this far: the comment is
// refused at compose time and nothing is raised (`writeTaskComment`).
//
// Only the comment's client items are read, by the comment's id, in the
// caller's business: a staff mention waits in the inbox for the delivery
// worker's own timing, and nothing of another comment or business is sent.

import type { BusinessId, Database } from '../../core-records/src/index.ts';
import type { Broker } from './broker-types.ts';
import { sendInboxEmail, type EmailResult, type MailSettings } from './broker-email.ts';

/** Email each client a committed comment named. One result per client item, in raised order. */
export async function tellCommentClients(
  database: Database,
  businessId: BusinessId,
  commentId: string,
  broker: Broker,
  mail: MailSettings,
): Promise<readonly EmailResult[]> {
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
  const results: EmailResult[] = [];
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop -- one send at a time, each its own attempt
    results.push(await sendInboxEmail(database, businessId, item.id, broker, mail));
  }
  return results;
}
