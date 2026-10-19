// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 (#2017): whether the broker may send one review shepherd item now. Asked inside the
// broker's checking transaction (`core-custody/src/broker-email.ts` `checkItem`), after the
// item and its task are locked, every time it would send: a comment the shepherd did not write
// is not this module's to judge. A shepherd send stands only while the occurrence's activation
// is still enabled on its version with its standing approval unrevoked, the item's recipient is
// one the send named, and either a person approved the send's exact digest or a live standing
// mandate covers the shepherd's class for the review's client. A mandate refusal wins over a
// mandate, never over a person's approval of the exact send.

import { shepherdSendFor, type TenantQuery } from '../../core-records/src/index.ts';
import { standingMandateVerdict } from './mandates.ts';

/** The action class a standing mandate names to cover the shepherd's weekly email. */
export const SHEPHERD_ACTION_CLASS = 'review.shepherd.email';

/** An email moves no money: asked at zero, in the currency the installation's mandates use. */
const SHEPHERD_CURRENCY = 'AUD';

export type ShepherdSendVerdict = 'not-shepherd' | 'stands' | 'unapproved';

export async function shepherdSendStands(
  tx: TenantQuery,
  item: { readonly factKind: string; readonly factId: string; readonly recipient: string },
): Promise<ShepherdSendVerdict> {
  if (item.factKind !== 'record') return 'not-shepherd';
  const send = await shepherdSendFor(tx, item.factId);
  if (send === undefined) return 'not-shepherd';
  if (!send.standing || !send.recipients.includes(item.recipient)) return 'unapproved';
  if (send.approvedDigest !== null && send.approvedDigest === send.digest) return 'stands';
  const verdict = await standingMandateVerdict(tx, {
    clientId: send.partyId,
    actionClass: SHEPHERD_ACTION_CLASS,
    valueMinor: 0,
    currency: SHEPHERD_CURRENCY,
  });
  return verdict.covered ? 'stands' : 'unapproved';
}
