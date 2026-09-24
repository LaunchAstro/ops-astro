// SPDX-License-Identifier: AGPL-3.0-only
//
// Discover, lock, recheck: the contract's restart rule, in one place (ARCH
// candidate 4).
//
// A transaction that writes under row locks has to know its whole set before
// it takes the first lock, because the order is global and a lock taken late
// is a lock taken backwards. So it discovers the set without locks, takes all
// of it in `LOCK_ORDER`, and discovers again under the locks. A set that
// changed in between is a set this transaction locked the wrong rows for. It
// rolls back rather than extend its locks, before its first write, and the
// person command entry retries it once in a fresh transaction, which
// discovers again.

import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import { acquire, type LockRequest, type LockSet } from './locks.ts';

/**
 * The affected set changed between the unlocked discovery and the locks, so
 * this transaction holds the wrong lock set and rolls back rather than extend
 * it. Nothing was written. It is a schedule, not a fault: the person command
 * entry retries it once in a fresh transaction, which discovers again
 * (`isRetryableViolation`). Startup recovery does not retry, and fails
 * visibly with the message.
 */
export class AffectedSetChanged extends Error {
  override readonly name = 'AffectedSetChanged';
}

/**
 * How a rediscovered set is judged against the first discovery. `exact`: any
 * difference rolls back. `covered` (N1): a difference rolls back only when the
 * rediscovered set needs a lock this transaction does not hold, so a set that
 * only shrank goes on under the locks it has.
 */
export type RecheckRule = 'exact' | 'covered';

export interface Rediscovery<T> {
  /** Read-only, and run twice: once before the locks and once under them. */
  readonly discover: () => Promise<T>;
  /** The complete set a discovered value needs, with whatever else the caller locks in the same call. */
  readonly locks: (found: T) => readonly LockRequest[] | Promise<readonly LockRequest[]>;
  readonly rule: RecheckRule;
  /** The rollback's message, which names the site. */
  readonly changed: string;
}

export interface Rediscovered<T> {
  readonly locks: LockSet;
  /** What the discovery found under the locks. */
  readonly found: T;
}

/**
 * R1. The same set means the same parents, not only the same reservation ids:
 * a reservation whose lease, run or envelope changed between discovery and the
 * locks is a reservation this transaction locked the wrong rows for.
 */
const sameSet = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * N1. Whether a rediscovered set needs only locks this transaction already
 * holds. A concurrent handback or classification that committed between
 * discovery and the locks can only shrink a set (a hold is no longer held, a
 * lease no longer live), and proceeding with the smaller set extends nothing.
 * A set that needs a lock not held is the case the contract rolls back.
 */
const covered = (locks: LockSet, requests: readonly LockRequest[]): boolean =>
  requests.every((request) => locks.has(request.lockClass, request.id));

/** Discover, take the complete set in order, discover again, and judge the two by `rule`. */
export async function lockRediscovered<T>(
  tx: TenantQuery,
  step: Rediscovery<T>,
): Promise<Rediscovered<T>> {
  const before = await step.discover();
  const locks = await acquire(tx, await step.locks(before));
  const found = await step.discover();
  if (
    !sameSet(before, found) &&
    (step.rule === 'exact' || !covered(locks, await step.locks(found)))
  ) {
    throw new AffectedSetChanged(step.changed);
  }
  return { locks, found };
}

/**
 * The recheck alone, for a site whose discovery and locks are taken apart:
 * `grant.revoke` discovers its dependents before the authority-loss
 * classifier takes the set, and reads them again inside it.
 */
export function requireUnchanged<T>(before: T, after: T, changed: string): void {
  if (!sameSet(before, after)) throw new AffectedSetChanged(changed);
}
