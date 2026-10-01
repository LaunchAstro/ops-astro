// SPDX-License-Identifier: AGPL-3.0-only
//
// C40's two sends through custody, neither of which writes anything:
//
// - `askRecovery`: the login provider is asked to start a reset for one
//   address (`auth.recover`, the service key held in custody). Its answer
//   says nothing the caller may repeat: a known and an unknown address are
//   answered alike, and the caller answers the person the same either way.
// - `sendResetMail`: one reset mail, from the verified sender only, through
//   the catalogued `email.send`, its one link the reset page with the
//   provider's hashed token in the fragment (so no server's request log
//   holds it). What came back is read as every send's answer is; an answer
//   carrying the hashed token is malformed. Nothing returned holds the token.

import { AUTH_RECOVER, type SenderReport } from '../../core-connectors/src/index.ts';
import { answerOf, observed, routed, sendRoute } from './broker-email-route.ts';
import type { Broker } from './broker-types.ts';

/** Where a reset link lands: the reset page, the hashed token in the fragment. */
export const RESET_PATH = '/reset';

export type RecoveryAsked = 'asked' | 'fault' | 'not_catalogued';

/** Ask the login provider to start a reset for `address`. */
export async function askRecovery(broker: Broker, address: string): Promise<RecoveryAsked> {
  const found = routed(broker, AUTH_RECOVER.key);
  if (found === undefined) return 'not_catalogued';
  const { operation, route, adapter } = found;
  const built = adapter.build({ email: address });
  const outcome = await broker.custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
  });
  return answerOf(outcome, operation).ok ? 'asked' : 'fault';
}

/** The reset link for an app origin and the provider's hashed token. */
export const resetLink = (appOrigin: string, tokenHash: string): string =>
  `${new URL(RESET_PATH, appOrigin).href}#token_hash=${tokenHash}`;

export type ResetMailSent =
  | { readonly state: 'accepted' | 'failed'; readonly evidence: string }
  | { readonly state: 'refused'; readonly evidence: 'SENDER_NOT_VERIFIED' | 'NOT_CATALOGUED' };

/** One reset mail to `to`, carrying the link for `tokenHash`. */
export async function sendResetMail(
  broker: Broker,
  mail: { readonly appOrigin: string; readonly from: string; readonly sender: SenderReport },
  to: string,
  tokenHash: string,
): Promise<ResetMailSent> {
  const found = sendRoute(broker, mail);
  if (found === 'SENDER_NOT_VERIFIED') return { state: 'refused', evidence: found };
  if (typeof found === 'string') return { state: 'refused', evidence: 'NOT_CATALOGUED' };
  const { operation, route, adapter } = found;
  const built = adapter.build({
    to,
    from: mail.from,
    address: resetLink(mail.appOrigin, tokenHash),
  });
  const outcome = await broker.custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
  });
  // An answer is evidence about the message, never a place the link's token is kept.
  const read = observed(outcome, operation);
  return read.evidence.includes(tokenHash) ? { state: 'failed', evidence: 'malformed' } : read;
}
