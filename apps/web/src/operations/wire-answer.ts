// SPDX-License-Identifier: AGPL-3.0-only
//
// How the typed client (`client.ts`) reads what came back: a refusal in the
// server's one shape, the two codes that end a session, and the words for a
// call that produced no answer at all. Nothing here sends anything.

import type { CommandRefusal } from '../../../../packages/core-wire/src/index.ts';

type WireRefusal = CommandRefusal;

/**
 * The two codes that mean the bearer is no longer a credential.
 *
 * Paired with the 401 rather than trusted alone: the code names the decision
 * and the status names the boundary that made it, and a 403 carrying either of
 * these would be a different answer than the one this rule is about.
 */
export const SESSION_ENDED: ReadonlySet<string> = new Set([
  'AUTH_UNKNOWN_LOGIN',
  'AUTH_SESSION_EXPIRED',
]);

export function isWireRefusal(value: unknown): value is WireRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return body['refused'] === true && typeof body['code'] === 'string';
}

/** Why a call produced no answer, in words. */
export const describe = (error: unknown): string =>
  error instanceof Error ? error.message : 'The request did not reach the API.';
