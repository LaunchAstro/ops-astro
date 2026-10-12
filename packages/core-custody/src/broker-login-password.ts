// SPDX-License-Identifier: AGPL-3.0-only
//
// C40 (ORCH77-C40B): a reset's new password set at the login provider under
// the catalogued `auth.update_user_password`, through custody, so the service
// key stays in custody's process. The broker's process sends the login's id
// and the password once and keeps neither.
//
// What comes back is read by the operation's answer schema to the user's id
// alone, and it must be the id asked for. The provider's 422 is `refused`: its
// no to the password itself, with nothing changed. Any other answer, one that
// names another user, has a field named for a password, or is oversized,
// redirected, malformed or slow, is a `fault`: the password may or may not be
// set.
//
// At most the catalogued concurrency, and the route's ceiling, are with the
// provider at once from this process: a reset over either waits for room, up
// to its deadline. The deadline is the reset window's end, which custody
// holds too (`notAfter`), so a call paused past it is never sent: after the
// window lapses, a session opened with the old password is no longer ended.

import {
  AUTH_UPDATE_USER_PASSWORD,
  PASSWORD_REFUSED_STATUS,
  type AdapterRequest,
  type ModelOperation,
} from '../../core-connectors/src/index.ts';
import type { Broker, BrokerRoute } from './broker-types.ts';

export type LoginPasswordSet = 'set' | 'refused' | 'fault';

/** The resets each custody has with the provider now, and the resets waiting for room. */
const sending = new WeakMap<object, { count: number; waiting: (() => void)[] }>();

/** A place among `limit` at once before `deadline` (wall-clock ms), and its release; or none. */
async function placeFor(
  custody: object,
  limit: number,
  deadline: number,
): Promise<(() => void) | undefined> {
  if (!Number.isSafeInteger(limit) || limit < 1) return undefined;
  const gate = sending.get(custody) ?? { count: 0, waiting: [] };
  sending.set(custody, gate);
  while (gate.count >= limit) {
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    // oxlint-disable-next-line no-await-in-loop -- each wake asks for room again
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, left);
      gate.waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  gate.count += 1;
  return () => {
    gate.count -= 1;
    for (const wake of gate.waiting.splice(0)) wake();
  };
}

type Outcome = Awaited<ReturnType<Broker['custody']['dispatch']>>;

/** The built call through custody once it has a place, or undefined when none comes by its deadline. */
async function dispatchInPlace(
  broker: Broker,
  sent: {
    readonly operation: ModelOperation;
    readonly route: BrokerRoute;
    readonly built: AdapterRequest;
  },
  notAfter: number | undefined,
): Promise<Outcome | undefined> {
  const { operation, route, built } = sent;
  const deadline = notAfter ?? Date.now() + operation.timeoutMs;
  const limit = Math.min(operation.concurrency, route.ceiling);
  const release = await placeFor(broker.custody, limit, deadline);
  if (release === undefined) return undefined;
  try {
    return await broker.custody.dispatch(route.credentialRef, {
      destination: operation.destination,
      path: built.path,
      method: built.method,
      body: built.body,
      timeoutMs: operation.timeoutMs,
      maxResponseBytes: operation.maxResponseBytes,
      ...(notAfter === undefined ? {} : { notAfter }),
    });
  } finally {
    release();
  }
}

/**
 * Set the password of the login whose provider id is `id`: set, refused, or a
 * fault. `notAfter` (wall-clock ms) is the reset window's end: no call goes
 * after it.
 */
export async function setLoginPassword(
  broker: Broker,
  id: string,
  password: string,
  notAfter?: number,
): Promise<LoginPasswordSet> {
  const operation = broker.operations.get(AUTH_UPDATE_USER_PASSWORD.key);
  const route = broker.routes.find((entry) => entry.provider === operation?.provider);
  const adapter = operation === undefined ? undefined : broker.providers.get(operation.provider);
  if (operation === undefined || route === undefined || adapter === undefined) return 'fault';
  let built: AdapterRequest;
  try {
    built = adapter.build({ id, password });
  } catch {
    return 'fault';
  }
  const outcome = await dispatchInPlace(broker, { operation, route, built }, notAfter);
  if (outcome === undefined || outcome.kind !== 'answered') return 'fault';
  const { outbound } = outcome;
  if (!outbound.ok) {
    return outbound.fault === 'status' && outbound.status === PASSWORD_REFUSED_STATUS
      ? 'refused'
      : 'fault';
  }
  let body: unknown;
  try {
    body = JSON.parse(outbound.body);
  } catch {
    return 'fault';
  }
  // An answer is the user's id, never a place the password is kept.
  if (namesPassword(outbound.body)) return 'fault';
  return operation.answer(body)?.text === id ? 'set' : 'fault';
}

/**
 * Whether an answer has a field named for a password, at any depth, or
 * cannot be read through to say. Its names, not its values: an honest user
 * object's `aud` and `role` are `authenticated`, which a password may be too.
 */
function namesPassword(text: string): boolean {
  let named = false;
  try {
    JSON.parse(text, (key, value: unknown) => {
      named ||= /password/iu.test(key);
      return value;
    });
  } catch {
    // Too deep to walk (the reviver's stack overflows), or malformed: an
    // answer not read through has not shown it names no password.
    return true;
  }
  return named;
}
