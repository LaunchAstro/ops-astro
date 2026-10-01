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

/** Stub (tests first): nobody is told. */
export async function tellCommentClients(
  database: Database,
  businessId: BusinessId,
  commentId: string,
  broker: Broker,
  mail: MailSettings,
): Promise<readonly EmailResult[]> {
  void [database, businessId, commentId, broker, mail, sendInboxEmail];
  return await Promise.resolve([]);
}
