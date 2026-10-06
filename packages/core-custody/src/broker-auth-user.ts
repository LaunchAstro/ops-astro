// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: a login made at the login provider (`auth.create_user`), or set again
// under our id (`auth.update_user`), through custody, which keeps the service key; this
// process sends the id, address and password once and keeps none. The answer must name
// the id asked for. `refused` is the provider's proof nothing changed (`email_exists`, or
// `user_not_found` on an update); `weak_password` is `password`; a call never answered is
// `lost`; anything else (another id, a field for a password, an answer oversized,
// redirected or malformed) is a fault.

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
  | { readonly ok: false; readonly kind: 'refused' | 'password' | 'fault' | 'lost' };

const FAULT = { ok: false, kind: 'fault' } as const;
const LOST = { ok: false, kind: 'lost' } as const;

/** Whether an answer has a field named for a password, at any depth: names, not values. */
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
  if (found === undefined) return FAULT;
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
  if (outcome.kind === 'worker_lost') return LOST;
  if (outcome.kind === 'answered') {
    const { outbound } = outcome;
    if (!outbound.ok) {
      if (outbound.fault === 'timeout' || outbound.fault === 'network') return LOST;
      // One status means more than one thing (422): the refusal's code says which.
      const code = outbound.fault === 'status' ? outbound.code : undefined;
      if (code === AUTH_WEAK_PASSWORD) return { ok: false, kind: 'password' };
      const proof = operation.nothingHappened;
      const refused = code !== undefined && proof !== 'not_reconcilable' && proof.includes(code);
      return refused ? { ok: false, kind: 'refused' } : FAULT;
    }
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

/** How many calls per business, the route's ceiling, and how long a claim holds. */
export type LoginLimits = Readonly<Record<'concurrency' | 'ceiling' | 'boundMs', number>>;

/** The limits both calls share (a claim outlives both timeouts by 5 s); none when one is missing. */
export function loginLimits(broker: Broker): LoginLimits | undefined {
  const found = [AUTH_CREATE_USER.key, AUTH_UPDATE_USER.key].map((key) => routed(broker, key));
  if (found.some((one) => one === undefined)) return undefined;
  const [create, update] = found as [Routed, Routed];
  return {
    concurrency: Math.min(create.operation.concurrency, update.operation.concurrency),
    ceiling: Math.min(create.route.ceiling, update.route.ceiling),
    boundMs: create.operation.timeoutMs + update.operation.timeoutMs + 5_000,
  };
}
