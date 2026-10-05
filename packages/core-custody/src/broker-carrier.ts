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
  const carrier = await broker.custody.describe(route.credentialRef, destination);
  return carrier?.credentialKind === route.credentialKind ? carrier.account : null;
}
