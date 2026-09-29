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
//
// The command-layer locks sit outside this list and always come first,
// before any lock `acquire` takes. They are the envelope's: the `serialise` key a
// placement command names (`prepare.ts`, `serialiseOn`), the target row it
// locks for a revision check (`lockTask`), and the sibling-set key a rank
// decision takes (`core-records/src/tasks/placement.ts`, `lockSiblings`). The
// commands that take them are ordinary record writes that never reach
// `acquire`; the runtime's commands declare `targetLock: 'runtime'` or no
// target, so the envelope locks nothing for them and this order starts clean.
// The grant rows an operation's authority rests on are the other class outside
// the list, also taken first: decide, pickup and cancellation hold theirs `for
// share` (`holdCoveringGrants`) and `grant.revoke` its own `for update`, before
// `acquire`. A handler that re-reads a row this set already holds, as
// `task.propose` re-reads its task `for update` to compare the revision,
// takes no new lock.
// A model call (AW-01) takes none of these: its run's task `for share` (the
// `task` class, so a `task.set_party` cannot move the task's client while the
// call is decided, C60; it is also the one row a bound field reads, S3),
// then its run `for update` (the `run` class: a call that reaches the
// ceiling moves the run into the budget wait, AW-05, `broker-wait.ts`),
// then its lease, delegation and reservation rows in that order
// (`core-custody/src/broker-facts.ts`), then its ceiling key per business and
// operation, then its route's key, which every business shares
// (`broker-reserve.ts`), last. Settlement takes the lease, delegation and
// reservation only: what it settles was already sent.
// The pinned read (AW-02, `definitions-read.ts`) takes one lock, its lease,
// through `acquire`, before it writes its ledger row.
// Every advisory lock, the chain class included, is taken through the one
// helper, `advisoryLock` in `core-records/src/tenancy/database.ts`.
// `tests/runtime/cq-8-db.test.ts` records each transaction's lock statements
// and fails if a command-layer lock follows one of these.

import { advisoryLock, type TenantQuery } from '../../core-records/src/index.ts';

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
      await advisoryLock(tx, `${tx.businessId}:${request.id}`);
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
