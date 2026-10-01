// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: a login made at the login provider when an invitation is
// accepted, under the catalogued `auth.create_user`, through custody, so the
// service key stays in custody's process. The broker's process sends the
// address and the password once and keeps neither.
//
// What comes back is read by the operation's answer schema to the new
// user's id alone. The provider's `email_exists` answer (422) is positive
// proof nothing was made: the address already holds a login. Any other
// answer, an answer that carries the password among them, or one that is
// oversized, redirected, malformed or slow, is a fault, and the caller
// spends nothing and keeps nothing.

import { AUTH_CREATE_USER, AUTH_EXISTS_STATUS } from '../../core-connectors/src/index.ts';
import { answerOf, routed } from './broker-email-route.ts';
import type { Broker } from './broker-types.ts';

export type LoginMade =
  | { readonly ok: true; readonly subject: string }
  | { readonly ok: false; readonly kind: 'exists' | 'fault' | 'not_catalogued' };

/** Ask the login provider for one confirmed login: its subject, or why there is none. */
export async function createLogin(
  broker: Broker,
  address: string,
  password: string,
): Promise<LoginMade> {
  const found = routed(broker, AUTH_CREATE_USER.key);
  if (found === undefined) return { ok: false, kind: 'not_catalogued' };
  const { operation, route, adapter } = found;
  const built = adapter.build({ email: address, password });
  const outcome = await broker.custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
  });
  if (outcome.kind === 'answered') {
    const { outbound } = outcome;
    if (!outbound.ok) {
      const exists = outbound.fault === 'status' && outbound.status === AUTH_EXISTS_STATUS;
      return { ok: false, kind: exists ? 'exists' : 'fault' };
    }
    // An answer is the user's id, never a place the password is kept.
    if (outbound.body.includes(password)) return { ok: false, kind: 'fault' };
  }
  const answer = answerOf(outcome, operation);
  return answer.ok ? { ok: true, subject: answer.text } : { ok: false, kind: 'fault' };
}
