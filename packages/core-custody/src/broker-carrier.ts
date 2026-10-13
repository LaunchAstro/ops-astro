// SPDX-License-Identifier: AGPL-3.0-only
//
// The account a model call goes out on, as custody names it before the send
// (catalogue #439, #943). The broker records it on the call's row with the
// route's provider and credential, and the reconciliation pass releases a
// held call only when custody's lookup answers on the same account
// (`broker-reconcile.ts`).

import type { Broker, BrokerRoute } from './broker-types.ts';

/**
 * The account custody names for the route's credential at `destination`,
 * recorded with the send (AW-10, catalogue #439): null when custody holds no
 * such credential there, or holds it as another kind than the route says,
 * so a later lookup proves nothing and a person records the outcome.
 */
export async function sendingAccount(
  broker: Broker,
  route: BrokerRoute,
  destination: string,
): Promise<string | null> {
  return (await sendingCarrier(broker, route, destination)).account;
}

/**
 * The account, as `sendingAccount` names it, and whether custody presents
 * nothing for the route's credential there: only then may the answer be
 * streamed, since an answer to a presented credential may echo it across
 * records custody redacts one at a time. Unknown to custody, it presents.
 */
export async function sendingCarrier(
  broker: Broker,
  route: BrokerRoute,
  destination: string,
): Promise<{ readonly account: string | null; readonly presentsNothing: boolean }> {
  const carrier = await broker.custody.describe(route.credentialRef, destination);
  const same = carrier?.credentialKind === route.credentialKind;
  return { account: same ? carrier.account : null, presentsNothing: carrier?.presents === false };
}
