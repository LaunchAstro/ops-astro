// SPDX-License-Identifier: AGPL-3.0-only
//
// The global lock order, in one place, as code.
//
// The transaction contract states it as prose: "business cap, envelope,
// task/work context, run/step, proposal-lineage coordination and gate rows,
// current lease, delegation, reservation, operation record; take only the
// complete set needed by the operation, in that order and stable key order
// within a class."
//
// Prose in a document is an order four handlers each re-implement. `acquire`
// takes the whole set an operation needs, sorts it by class and then by key
// inside a class, and issues the `select ... for update` statements in that
// order. A handler that asks for a lease and a cap gets them cap-first
// whatever order it listed them in, and the deadlock that "helpers must not
// acquire an unheld earlier-order lock" is warning about becomes something
// `acquire` structurally cannot do, rather than something a reviewer catches.
//
// It also records what it took. `LockSet.holds` is what the helpers check
// against, so the classifier calling in from `handback.ts` can assert it is
// running inside the locks it needs instead of taking them again.

import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';

/** The classes, in the contract's order. The number is the order. */
export const LOCK_ORDER = [
  // R10. The decision chain is allocated per business, and allocation has to
  // be serialised somewhere earlier than any row two independent decisions
  // might not share: two approvals on different tasks under different caps
  // hold no row in common, so both read the same chain head and the unique
  // index aborts one otherwise valid decision instead of ordering them. This
  // class is first because it is the widest thing any operation takes.
  'chain',
  'cap',
  'envelope',
  'task',
  'run',
  'step',
  'lineage',
  'gate',
  'lease',
  'delegation',
  'reservation',
  'operation',
] as const;

export type LockClass = (typeof LOCK_ORDER)[number];

export interface LockRequest {
  readonly lockClass: LockClass;
  readonly id: string;
}

const TABLE_OF: Readonly<Record<LockClass, string>> = {
  // `chain` names no table: there is no per-business chain row to lock, and
  // inventing one would be a write before the lock set. It is taken as a
  // transaction-scoped advisory lock instead, released at commit or rollback
  // like every other lock here. The unique index on `(business_id, seq)`
  // remains the independent second barrier.
  chain: '',
  cap: 'public.budget_caps',
  envelope: 'public.task_envelopes',
  task: 'public.records',
  run: 'public.planned_runs',
  step: 'public.planned_steps',
  lineage: 'public.proposal_lineages',
  gate: 'public.gates',
  lease: 'public.leases',
  delegation: 'public.delegations',
  reservation: 'public.reservations',
  operation: 'public.operations',
};

export interface LockSet {
  readonly holds: ReadonlySet<string>;
  has(lockClass: LockClass, id: string): boolean;
  /** Throws rather than refuses: a helper reaching outside its locks is a bug, not an answer. */
  require(lockClass: LockClass, id: string): void;
}

function keyOf(lockClass: LockClass, id: string): string {
  return `${lockClass}:${id}`;
}

/**
 * Take the complete set, in order. Rows that do not exist are simply not
 * locked; the caller re-reads under the locks it did take and refuses there,
 * where it can say which row was missing.
 */
export async function acquire(
  tx: TenantQuery,
  requested: readonly LockRequest[],
): Promise<LockSet> {
  const unique = new Map<string, LockRequest>();
  for (const request of requested) unique.set(keyOf(request.lockClass, request.id), request);

  const ordered = [...unique.values()].toSorted((left, right) => {
    const byClass = LOCK_ORDER.indexOf(left.lockClass) - LOCK_ORDER.indexOf(right.lockClass);
    // Stable key order inside a class: two transactions wanting the same two
    // envelopes take them in the same order, so neither waits on the other.
    return byClass !== 0 ? byClass : left.id.localeCompare(right.id);
  });

  for (const request of ordered) {
    if (request.lockClass === 'chain') {
      // eslint-disable-next-line no-await-in-loop
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${tx.businessId}:${request.id}`,
      ]);
      continue;
    }
    // Sequential on purpose, and `Promise.all` would defeat the whole module:
    // locks taken concurrently are locks taken in whatever order the server
    // happens to serve them, which is the deadlock this order exists to avoid.
    // eslint-disable-next-line no-await-in-loop
    await tx.query(
      `select 1 from ${TABLE_OF[request.lockClass]}
        where business_id = $1 and id = $2 for update`,
      [tx.businessId, request.id],
    );
  }

  const holds = new Set(unique.keys());
  return {
    holds,
    has: (lockClass, id) => holds.has(keyOf(lockClass, id)),
    require(lockClass, id) {
      if (!holds.has(keyOf(lockClass, id))) {
        throw new Error(
          `lock order: ${keyOf(lockClass, id)} is not held; acquire it with the rest of the set, not here`,
        );
      }
    },
  };
}
