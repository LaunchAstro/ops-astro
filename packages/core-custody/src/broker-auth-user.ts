// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: a login made at the login provider when an invitation is
// accepted, under the catalogued `auth.create_user`, through custody, so the
// service key stays in custody's process. The broker's process sends the id,
// the address and the password once and keeps none of them. No login the
// provider holds is ever set again.
//
// What comes back is read by the operation's answer schema to the user's id
// alone, and it must be the id asked for. The provider's positive proof that
// nothing was made is `refused`: `email_exists` (422), the address holding a
// login already. Any other answer, one that names another user, one
// that carries the password, or one oversized, redirected, malformed or slow,
// is a fault, and the caller spends nothing and binds nothing.
//
// `auth.read_user` reads one login under the id a signed-in session carries:
// its address when the provider confirmed it, read by the operation's answer
// schema, and the id must again be the one asked for. 404 is `refused`, no
// such login; anything else not answered in full is a fault.

import {
  AUTH_CREATE_USER,
  AUTH_EXISTS_STATUS,
  AUTH_NOT_FOUND_STATUS,
  AUTH_READ_USER,
} from '../../core-connectors/src/index.ts';
import { answerOf, routed } from './broker-email-route.ts';
import type { Broker } from './broker-types.ts';

/** The login asked for: the provider user's id (ours), the address and the password. */
export interface LoginAsked {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

export type LoginMade =
  | { readonly ok: true; readonly subject: string }
  | { readonly ok: false; readonly kind: 'refused' | 'fault' | 'not_catalogued' };

const FAULT = { ok: false, kind: 'fault' } as const;

/** Ask the login provider for one confirmed login under our id: refused when the address holds one. */
export async function createLogin(broker: Broker, login: LoginAsked): Promise<LoginMade> {
  const found = routed(broker, AUTH_CREATE_USER.key);
  if (found === undefined) return { ok: false, kind: 'not_catalogued' };
  const { operation, route, adapter } = found;
  const built = adapter.build({ id: login.id, email: login.email, password: login.password });
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
      const { fault, status } = outbound;
      return fault === 'status' && status === AUTH_EXISTS_STATUS
        ? { ok: false, kind: 'refused' }
        : FAULT;
    }
    // An answer is the user's id, never a place the password is kept.
    if (outbound.body.includes(login.password)) return FAULT;
  }
  const answer = answerOf(outcome, operation);
  return answer.ok && answer.text === login.id ? { ok: true, subject: answer.text } : FAULT;
}

/** One login read: its address when the provider confirmed it, else null; or why there is none. */
export type LoginRead =
  | { readonly ok: true; readonly confirmed: string | null }
  | { readonly ok: false; readonly kind: 'refused' | 'fault' | 'not_catalogued' };

const USER_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

/** Read the login under `id` (a provider user id, lower case) at the login provider. */
export async function readLogin(broker: Broker, id: string): Promise<LoginRead> {
  // An id the provider could not have issued asks nothing: no such login.
  if (!USER_ID.test(id)) return { ok: false, kind: 'refused' };
  const found = routed(broker, AUTH_READ_USER.key);
  if (found === undefined) return { ok: false, kind: 'not_catalogued' };
  const { operation, route, adapter } = found;
  const built = adapter.build({ id });
  const outcome = await broker.custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
  });
  if (outcome.kind === 'answered' && !outcome.outbound.ok) {
    const { fault, status } = outcome.outbound;
    return fault === 'status' && status === AUTH_NOT_FOUND_STATUS
      ? { ok: false, kind: 'refused' }
      : FAULT;
  }
  const answer = answerOf(outcome, operation);
  if (!answer.ok) return FAULT;
  const [subject, address] = answer.text.split(' ');
  return subject === id ? { ok: true, confirmed: address ?? null } : FAULT;
}
