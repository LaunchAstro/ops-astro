// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P2: the invitation's link, generated server-side by the login
// provider under the catalogued `auth.invite_link`, through custody, so the
// service key stays in custody's process. What comes back is read by the
// operation's answer schema to the hashed token alone; a refusal, a fault or
// any other answer (oversized, redirected, malformed, slow) is its fault's
// kind and nothing else, so the caller sends nothing and keeps nothing.

import { AUTH_INVITE_LINK } from '../../core-connectors/src/index.ts';
import { answerOf, routed, type Routed } from './broker-email-route.ts';
import type { Broker } from './broker-types.ts';
import type { Custody } from './custody.ts';

/** The catalogued link operation, routed, and the custody that carries it. */
export type LinkRoute = Routed & { readonly custody: Custody };

/**
 * The link route when the broker catalogues the login provider's invite
 * link; undefined when it does not (the send then mints its own token); a
 * refusal when it is catalogued but has no route or adapter.
 */
export function linkRoute(broker: Broker): LinkRoute | undefined | 'OPERATION_NOT_CATALOGUED' {
  if (!broker.operations.has(AUTH_INVITE_LINK.key)) return undefined;
  const found = routed(broker, AUTH_INVITE_LINK.key);
  return found === undefined ? 'OPERATION_NOT_CATALOGUED' : { ...found, custody: broker.custody };
}

/** One invite link's hashed token for one address, or the fault's kind. */
export async function inviteToken(
  { operation, route, adapter, custody }: LinkRoute,
  address: string,
): Promise<
  { readonly ok: true; readonly token: string } | { readonly ok: false; readonly fault: string }
> {
  const built = adapter.build({ email: address });
  const outcome = await custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
  });
  const answer = answerOf(outcome, operation);
  return answer.ok ? { ok: true, token: answer.text } : answer;
}
