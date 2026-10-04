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
// names another user, carries the password, or is oversized, redirected,
// malformed or slow, is a `fault`: the password may or may not be set.

import {
  AUTH_UPDATE_USER_PASSWORD,
  PASSWORD_REFUSED_STATUS,
  type AdapterRequest,
} from '../../core-connectors/src/index.ts';
import type { Broker } from './broker-types.ts';

export type LoginPasswordSet = 'set' | 'refused' | 'fault';

/** Set the password of the login whose provider id is `id`: set, refused, or a fault. */
export async function setLoginPassword(
  broker: Broker,
  id: string,
  password: string,
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
  const outcome = await broker.custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
  });
  if (outcome.kind !== 'answered') return 'fault';
  const { outbound } = outcome;
  if (!outbound.ok) {
    return outbound.fault === 'status' && outbound.status === PASSWORD_REFUSED_STATUS
      ? 'refused'
      : 'fault';
  }
  // An answer is the user's id, never a place the password is kept.
  if (outbound.body.includes(password)) return 'fault';
  let body: unknown;
  try {
    body = JSON.parse(outbound.body);
  } catch {
    return 'fault';
  }
  return operation.answer(body)?.text === id ? 'set' : 'fault';
}
