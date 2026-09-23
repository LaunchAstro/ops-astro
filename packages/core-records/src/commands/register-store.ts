// SPDX-License-Identifier: AGPL-3.0-only
//
// The repeat-request register: the `operations` table, and the shape of an
// identity.
//
// One row is one attempt at one operation identity, written whether the
// attempt applied or was refused. That is what makes T1-N2 hold across a
// refused first attempt: the same identity arriving with a *different*
// payload has something to be compared against. A refusal is a result, it is
// recorded, and it replays.
//
// The durable handle lives here too, beside the row that stores it. A replay
// returns the stored result exactly, so the two have to agree about its shape:
// everything in it is a string, a number or null, and it survives the round
// trip through `jsonb` unchanged.

import { randomUUID } from 'node:crypto';
import { AffectedSetChanged } from '../../../core-runtime/src/recovery.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { isCommandRefusal, type CommandRefusal } from './refusal.ts';
import type { CommandName } from './surface.ts';

/** What a caller gets when a command applies: a durable handle, never a record. */
export interface CommandHandle {
  readonly command: CommandName;
  readonly recordId: string | null;
  readonly revision: number | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type CommandResult = CommandHandle | CommandRefusal;

// Eight to two hundred characters from a bounded alphabet, matching the check
// constraint on `operations.operation_id`. Short enough to type, long enough
// that a client cannot collide by accident on a counter starting at one.
export const OPERATION_ID: RegExp = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;

export interface RegisteredAttempt {
  readonly command: string;
  readonly payload_digest: string;
  readonly outcome: 'applied' | 'refused';
  readonly result: Readonly<Record<string, unknown>>;
}

/**
 * The attempt this actor made under this identity, if any.
 *
 * Scoped to the actor and not to the business. The register is read before
 * authority is checked — a replay must not do the work again — so a
 * business-wide identity would let anyone who could name another caller's
 * identity be handed that caller's result. A cross-model review found exactly
 * that: a member with no grant at all, presenting a colleague's
 * `operation_id` and the same payload, received the colleague's handle.
 */
export async function lookupAttempt(
  tx: TenantQuery,
  actorId: string,
  operationId: string,
): Promise<RegisteredAttempt | undefined> {
  const rows = await tx.query<RegisteredAttempt>(
    `select command, payload_digest, outcome, result from operations
      where business_id = $1 and actor_id = $2 and operation_id = $3`,
    [tx.businessId, actorId, operationId],
  );
  return rows[0];
}

/** Record the attempt, whatever it came to. There is no update path. */
export async function registerAttempt(
  tx: TenantQuery,
  attempt: {
    readonly operationId: string;
    readonly command: CommandName;
    readonly actorId: string;
    readonly digest: string;
    readonly result: CommandHandle | CommandRefusal;
    readonly recordId: string | null;
  },
): Promise<void> {
  const { result } = attempt;
  await tx.query(
    `insert into operations
       (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
        record_id, revision)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10)`,
    [
      tx.businessId,
      randomUUID(),
      attempt.operationId,
      attempt.command,
      attempt.actorId,
      attempt.digest,
      isCommandRefusal(result) ? 'refused' : 'applied',
      result,
      attempt.recordId,
      isCommandRefusal(result) ? null : result.revision,
    ],
  );
}

/**
 * What a caller can lose a race on while still asking the right question, each
 * named rather than "any unique violation" or "any error".
 *
 * Two unique claims, and one rollback. `record_unique_values_claim_idx` is a
 * counted `key` two creates picked at once. `operations_identity_key` is two
 * callers presenting one identity at once. `AffectedSetChanged` is a
 * cancellation or revocation whose discovered set grew under its locks (a
 * pickup committed a lease in between), so it rolled back, writing nothing,
 * rather than extend its lock set; the retry discovers again and takes the
 * right locks (TRANSACTION-CONTRACT TC11: a concurrent schedule is not an
 * infrastructure failure). Anything else — a unique field a later part adds,
 * say — is a fault that should surface as one rather than be retried into a
 * second failure, which is what a blanket retry on 23505 did before a review
 * pointed it out.
 */
const RETRYABLE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'record_unique_values_claim_idx',
  'operations_identity_key',
]);

export function isRetryableViolation(cause: unknown): boolean {
  if (cause instanceof AffectedSetChanged) return true;
  if (typeof cause !== 'object' || cause === null) return false;
  const error = cause as { readonly code?: unknown; readonly constraint_name?: unknown };
  if (error.code !== '23505') return false;
  return (
    typeof error.constraint_name === 'string' && RETRYABLE_CONSTRAINTS.has(error.constraint_name)
  );
}
