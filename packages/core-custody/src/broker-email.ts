// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's email send (AW-07b): the only way a person is told by email
// that an inbox item waits. The delivery worker names an item and nothing
// else; the recipient, their address and the link are read here, and the
// message leaves through custody under the catalogued `email.send`.
//
// 1. Check, in the item's business: the operation is catalogued and routed,
//    the item is open, its recipient can read its task now (so another
//    client's task is never mailed about), they have a confirmed address, and
//    no earlier email attempt on the item might have gone out. A refusal
//    writes nothing and sends nothing. Then the attempt is recorded `asked`.
// 2. Send, through custody, a request the adapter built from the declared
//    fields. The body carries the item's address and never a decision.
// 3. Record what came back as the attempt's next observation: `accepted`
//    with the provider's message id, or `failed` with the fault's kind. No
//    answer body, address or link is kept, returned or written anywhere.
//
// Nothing here reads a provider answer as an instruction, and no path from
// an answer reaches the item's work state or any gate: an attempt never
// moves the item (`recordDeliveryAttempt`).

import type { BusinessId, Database } from '../../core-records/src/index.ts';
import type { Broker } from './broker-types.ts';

/** The catalogued name the send dispatches by. */
export const EMAIL_OPERATION = 'email.send';

/** Where the installation's own pages are, and who its mail is from. */
export interface MailSettings {
  readonly appOrigin: string;
  readonly from: string;
}

export type EmailRefusal =
  | 'OPERATION_NOT_CATALOGUED'
  | 'ITEM_NOT_OPEN'
  | 'ITEM_WITHHELD'
  | 'NO_ADDRESS'
  | 'EMAIL_MAY_HAVE_GONE';

export type EmailResult =
  | { readonly ok: true; readonly attemptId: string; readonly state: 'accepted' }
  | { readonly ok: false; readonly code: EmailRefusal }
  | {
      readonly ok: false;
      readonly code: 'EMAIL_FAILED';
      readonly attemptId: string;
      readonly fault: string;
    };

/** Tell an inbox item's recipient by email where to go, through the broker only. Not built yet. */
export async function sendInboxEmail(
  _database: Database,
  _businessId: BusinessId,
  _itemId: string,
  _broker: Broker,
  _mail: MailSettings,
): Promise<EmailResult> {
  throw new Error('sendInboxEmail: not built yet');
}
