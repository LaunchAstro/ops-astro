// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: a login made at the login provider when an invitation is
// accepted, under the catalogued `auth.create_user`, and set again under
// `auth.update_user` when an earlier accept made it and never bound it, each
// through custody, so the service key stays in custody's process. The
// broker's process sends the id, the address and the password once and keeps
// none of them.
//
// What comes back is read by the operation's answer schema to the user's id
// alone, and it must be the id asked for. The provider's positive proof that
// nothing was made or changed is `refused`: `email_exists` on either, the
// address holding another login, and `user_not_found` on an update, no user
// under that id, read from the refusal's code (custody passes on nothing
// else of it), since 422 is also `weak_password`, the provider's no to the
// password itself: `password`. Any other answer, one that names another user, one
// with a field for a password, or one oversized, redirected, malformed or
// slow, is a fault, and the caller spends nothing and binds nothing.

import {
  AUTH_CREATE_USER,
  AUTH_UPDATE_USER,
  AUTH_WEAK_PASSWORD,
} from '../../core-connectors/src/index.ts';
import { answerOf, routed, type Routed } from './broker-email-route.ts';
import type { Broker } from './broker-types.ts';

/** The login asked for: the provider user's id (ours), the address and the password. */
export interface LoginAsked {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

export type LoginMade =
  | { readonly ok: true; readonly subject: string }
  | { readonly ok: false; readonly kind: 'refused' | 'password' | 'fault' | 'not_catalogued' };

const FAULT = { ok: false, kind: 'fault' } as const;

/**
 * Whether an answer has a field named for a password, at any depth. Its
 * names, not its values: an honest user object's `aud` and `role` are
 * `authenticated`, which a password may be too.
 */
function namesPassword(text: string): boolean {
  let named = false;
  try {
    JSON.parse(text, (key, value: unknown) => {
      named ||= /password/iu.test(key);
      return value;
    });
  } catch {
    // Malformed: the answer's own reading refuses it.
  }
  return named;
}

/** One catalogued call for one login: its subject, or why there is none. */
async function ask(broker: Broker, key: string, login: LoginAsked): Promise<LoginMade> {
  const found = routed(broker, key);
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
      // One status means more than one thing (422): the refusal's code says which.
      const code = outbound.fault === 'status' ? outbound.code : undefined;
      if (code === AUTH_WEAK_PASSWORD) return { ok: false, kind: 'password' };
      const proof = operation.nothingHappened;
      const refused = code !== undefined && proof !== 'not_reconcilable' && proof.includes(code);
      return refused ? { ok: false, kind: 'refused' } : FAULT;
    }
    // An answer is the user's id, never a place the password is kept.
    if (namesPassword(outbound.body)) return FAULT;
  }
  const answer = answerOf(outcome, operation);
  return answer.ok && answer.text === login.id ? { ok: true, subject: answer.text } : FAULT;
}

/** Ask the login provider for one confirmed login under our id: refused when the address holds one. */
export async function createLogin(broker: Broker, login: LoginAsked): Promise<LoginMade> {
  return await ask(broker, AUTH_CREATE_USER.key, login);
}

/** Set the login under our id to this address and password: refused when there is none, or the address is another's. */
export async function updateLogin(broker: Broker, login: LoginAsked): Promise<LoginMade> {
  return await ask(broker, AUTH_UPDATE_USER.key, login);
}

/** What an accept's provider calls may hold: how many per business, the route's ceiling, how long. */
export interface LoginLimits {
  readonly concurrency: number;
  readonly ceiling: number;
  readonly boundMs: number;
}

/** A claim outlives both calls' timeouts by this much, then lapses. */
const CLAIM_GRACE_MS = 5_000;

/** The limits `createLogin` and `updateLogin` share, or nothing when either is not catalogued. */
export function loginLimits(broker: Broker): LoginLimits | undefined {
  const both = [AUTH_CREATE_USER.key, AUTH_UPDATE_USER.key].map((key) => routed(broker, key));
  if (both.includes(undefined)) return undefined;
  const found = both as Routed[];
  return {
    concurrency: Math.min(...found.map(({ operation }) => operation.concurrency)),
    ceiling: Math.min(...found.map(({ route }) => route.ceiling)),
    boundMs: found.reduce((sum, { operation }) => sum + operation.timeoutMs, CLAIM_GRACE_MS),
  };
}
