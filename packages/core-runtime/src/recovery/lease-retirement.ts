// SPDX-License-Identifier: AGPL-3.0-only
//
// Lease retirement: the live work a closing transition ends, the replay of
// recorded transitions after a restart, and the cancellation path. The rules
// it keeps are in `../recovery.ts`, the module's one surface.

import { revokeDelegation } from '../../../core-records/src/index.ts';
import type { TenantQuery, Subject } from '../../../core-records/src/index.ts';
import { raiseAlert } from '../alerts.ts';
import type { LockRequest, LockSet } from '../locks.ts';
import { lockedInstant } from '../clock.ts';
import { lockRediscovered } from '../rediscovery.ts';
import { refuse, type RuntimeResult } from '../refusals.ts';
import {
  AFFECTED_COLUMNS,
  AFFECTED_JOINS,
  checkAuthorityAt,
  classifyAll,
  discoverEligible,
  holdCoveringGrants,
  locksFor,
  type Affected,
  type Classification,
} from './classifier.ts';

/** A live lease on the work being closed, and the delegation it was issued under. */
export interface LiveWork {
  readonly lease_id: string;
  readonly run_id: string;
  readonly delegation_id: string | null;
}

/** Whose live leases `discoverLiveWork` reads. */
type LiveWorkTarget =
  | { readonly lineageId: string }
  | { readonly versionIds: readonly string[] }
  /** EX-01: the leases issued under these delegations, and these person leases, which carry none. */
  | { readonly delegationIds: readonly string[]; readonly personLeaseIds: readonly string[] };

/**
 * Read-only: the live leases on a lineage's runs, or on the runs of a set of
 * versions. Cancellation and supersession both end the work these leases
 * authorise, so their leases and delegations belong to the lock set those
 * operations take, discovered here before any lock. Authority loss
 * reads the same leases by the delegations and person leases it may cost.
 *
 * The run join filters nothing: every lease names a run in its own business.
 */
export async function discoverLiveWork(
  tx: TenantQuery,
  target: LiveWorkTarget,
): Promise<readonly LiveWork[]> {
  const [scope, parameters] =
    'lineageId' in target
      ? ['run.lineage_id = $2::uuid', [target.lineageId]]
      : 'versionIds' in target
        ? ['run.version_id = any($2::uuid[])', [target.versionIds]]
        : [
            `(l.delegation_id = any($2::uuid[])
               or (l.delegation_id is null and l.id = any($3::uuid[])))`,
            [target.delegationIds, target.personLeaseIds],
          ];
  return await tx.query<LiveWork>(
    `select l.id as lease_id, l.run_id, l.delegation_id
       from public.leases l
       join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
      where l.business_id = $1 and l.state = 'live'
        and ${scope}
      order by l.id`,
    [tx.businessId, ...parameters],
  );
}

export function liveWorkLocks(work: readonly LiveWork[]): readonly LockRequest[] {
  return work.flatMap((row) => [
    { lockClass: 'run' as const, id: row.run_id },
    { lockClass: 'lease' as const, id: row.lease_id },
    ...(row.delegation_id === null
      ? []
      : [{ lockClass: 'delegation' as const, id: row.delegation_id }]),
  ]);
}

/**
 * End a live lease, as `released` (its work is over) or `expired` (a
 * replacement takes its place). The `state = 'live'` guard is the one rule
 * every caller shares: a lease already ended keeps the end it had, and its
 * `released_at` is not moved. Under the caller's lock on the lease.
 */
export async function endLease(
  tx: TenantQuery,
  leaseId: string,
  to: 'released' | 'expired',
): Promise<void> {
  await tx.query(
    `update public.leases set state = $3, released_at = now()
      where business_id = $1 and id = $2 and state = 'live'`,
    [tx.businessId, leaseId, to],
  );
}

/**
 * End the work authority a transition has made obsolete: fence and release
 * each live lease, and revoke the delegation it was issued under. T5 names
 * both halves for cancellation ("releases the live lease and revokes the
 * delegation"); supersession retires the old version's work the same way, so
 * a holder of superseded work has nothing left to settle with. Revoked
 * rather than settled: nothing was handed back, and the next call the agent
 * makes on that credential re-evaluates it and is refused.
 *
 * Under the caller's locks, which must include every row named here.
 */
export async function retireWork(
  tx: TenantQuery,
  work: readonly LiveWork[],
  locks: LockSet,
): Promise<void> {
  for (const row of work) {
    locks.require('lease', row.lease_id);
    if (row.delegation_id !== null) locks.require('delegation', row.delegation_id);
    // eslint-disable-next-line no-await-in-loop
    await endLease(tx, row.lease_id, 'released');
    if (row.delegation_id !== null) {
      // Cancellation or supersession. A delegation authority loss already
      // revoked keeps that first cause; this write is then a no-op.
      // eslint-disable-next-line no-await-in-loop
      await revokeDelegation(tx, row.delegation_id, 'work_retired');
    }
  }
}

/**
 * A run whose claim ended in authority loss goes back to `planned`. Not a
 * terminal state: the lineage is still live and the version still approved,
 * and T5 lets "authority restoration or replacement work" obtain a new attempt
 * on it (line 86), which pickup's fresh-replacement branch does for a run that
 * is still open. Left `claimed`, it named a claim nothing held. A run already
 * handed back or cancelled is history and is not touched.
 *
 * Under the caller's locks, which must include each run.
 */
export async function reopenRuns(
  tx: TenantQuery,
  runIds: readonly string[],
  locks: LockSet,
): Promise<void> {
  if (runIds.length === 0) return;
  for (const id of runIds) locks.require('run', id);
  await tx.query(
    `update public.planned_runs set state = 'planned'
      where business_id = $1 and id = any($2::uuid[]) and state = 'claimed'`,
    [tx.businessId, [...new Set(runIds)]],
  );
}

/**
 * Restart replay. It finds reservations whose **recorded** transition already
 * made them nonclaimable and whose classification did not commit, and runs the
 * same classifier over them under the complete ordered lock set (R1).
 *
 * It manufactures no eligibility. The query below asks only about rows whose
 * lineage is terminal, whose version is superseded, whose lease was fenced or
 * whose delegation was revoked. Each is a fact another authorised operation
 * wrote, and none is age, a missing claimant or a null lease.
 */
export async function replayRecordedTransitions(
  tx: TenantQuery,
): Promise<readonly Classification[]> {
  // Discover, lock, rediscover, classify. The rediscovery is the contract's
  // restart rule: if the affected set changed between the unlocked discovery
  // and the locks, this transaction has the wrong lock set and must not write
  // under it.
  const { locks, found: after } = await lockRediscovered(tx, {
    discover: async () => discoverEligible(tx, null),
    locks: locksFor,
    rule: 'exact',
    changed:
      'recovery: the affected set changed under discovery; roll back and rediscover rather than extending the lock set',
  });

  return await classifyAll(
    tx,
    after,
    locks,
    (row) => ({ reservationId: row.reservation_id, cause: row.cause, causeId: row.cause_id }),
    async (row) => {
      // A revocation that committed without its classification leaves its
      // lease live, because only the revocation timestamp was written. The
      // lease and delegation are already in this set, so finishing the
      // transition here fences them rather than leaving an inert live claim on
      // the task until it expires.
      if (row.cause !== 'authority_revoked' || row.lease_id === null) return;
      await retireWork(
        tx,
        [{ lease_id: row.lease_id, run_id: row.run_id, delegation_id: row.delegation_id }],
        locks,
      );
      await reopenRuns(tx, [row.run_id], locks);
    },
  );
}

/**
 * The cancellation path's entry point: record the person's cancellation on the
 * lineage, fence and release the live lease, revoke the delegation it was
 * issued under, end its runs as cancelled, then classify **its own**
 * reservations. Exported because T5 names cancellation as one of the owning
 * transitions, and the command layer wires it.
 *
 * R1. Everything is discovered and locked before the first write, and the
 * classification is scoped to this lineage. Updating the lineage, then the
 * leases, then reaching the envelope through the classifier would leave a
 * cancellation holding the lineage waiting on an envelope a handback already
 * held, and classifying every eligible lineage in the business would reach
 * work it was not asked about.
 */
export async function cancelAndClassify(
  tx: TenantQuery,
  request: {
    readonly lineageId: string;
    readonly reason: string;
    /**
     * The person's write on the task (T5), held and re-read under the locks.
     * A recovery caller acting for no person passes none, and keeps the path
     * it had.
     */
    readonly authority?: {
      readonly subjects: readonly Subject[];
      readonly collection: string;
      readonly taskId: string;
      /**
       * Asked under the locks beside `write`. `task.cancel` passes `decide`
       * (T3a, `gate:decide`), so a decide grant that lapses while this waits on
       * its locks refuses the cancel.
       */
      readonly alsoDecide?: boolean;
    };
  },
): Promise<RuntimeResult<readonly Classification[]>> {
  const terminal = refuse(
    'LINEAGE_TERMINAL',
    `lineage ${request.lineageId} is not live, so there is nothing to cancel`,
    'Read its terminal reason. Cancelling twice is not a second cancellation.',
  );
  const live = await tx.query<{ readonly state: string }>(
    `select state from public.proposal_lineages where business_id = $1 and id = $2`,
    [tx.businessId, request.lineageId],
  );
  if (live[0]?.state !== 'live') return terminal;

  // Discovery before the locks: every reservation this lineage owns, whatever
  // its version's own state, because cancellation makes all of them
  // nonclaimable; and every live lease on its runs with the delegation it
  // was issued under, because cancellation ends that authority too.
  const discover = async (): Promise<readonly Affected[]> => {
    const rows = await tx.query<Affected>(
      `select ${AFFECTED_COLUMNS}, 'lineage_cancelled' as cause, lin.id as cause_id
         ${AFFECTED_JOINS}
        where res.business_id = $1 and res.state = 'held' and lin.id = $2
        order by res.id`,
      [tx.businessId, request.lineageId],
    );
    return rows;
  };

  // Rechecked under the locks and before the first write. A set that grew
  // means this transaction holds the wrong rows, and it rolls back rather
  // than extending its locks backwards; a set that only shrank (a handback
  // committed in between, N1) is covered by the locks held and goes on.
  //
  // The runs this cancellation ends are in the set too,
  // every planned or claimed one on the lineage, not only those behind a hold
  // or a live lease. Updating a run it had not locked would take that row after
  // the lineage, which is backwards: `task.decide` takes run before lineage,
  // and the two would close a cycle that Postgres breaks with 40P01. A run a
  // concurrent proposal adds in between needs a lock not held, and rolls back
  // here.
  const openRuns = async (): Promise<readonly string[]> =>
    (
      await tx.query<{ readonly id: string }>(
        `select id from public.planned_runs
          where business_id = $1 and lineage_id = $2 and state in ('planned', 'claimed')
          order by id`,
        [tx.businessId, request.lineageId],
      )
    ).map((row) => row.id);

  // The envelope checks write before any lock.
  // Held for share before the runtime set, as decide and pickup hold theirs:
  // a revocation that locked first is seen by the re-check below, and one
  // that comes second waits for this cancellation to commit.
  const authority = request.authority;
  if (authority !== undefined) {
    await holdCoveringGrants(tx, authority.subjects, authority.collection);
  }

  const {
    locks,
    found: [after, workAfter, runsAfter],
  } = await lockRediscovered(tx, {
    discover: async () =>
      [
        await discover(),
        await discoverLiveWork(tx, { lineageId: request.lineageId }),
        await openRuns(),
      ] as const,
    locks: ([held, work, runs]) => [
      ...locksFor(held),
      ...liveWorkLocks(work),
      ...runs.map((id) => ({ lockClass: 'run' as const, id })),
      { lockClass: 'lineage', id: request.lineageId },
    ],
    rule: 'covered',
    changed:
      'cancellation: the affected set changed under discovery; roll back and rediscover rather than extending the lock set',
  });

  if (authority !== undefined) {
    const at = await lockedInstant(tx);
    for (const action of authority.alsoDecide === true
      ? (['write', 'decide'] as const)
      : (['write'] as const)) {
      // Sequential: each is asked at the same locked instant, and the first
      // refusal is the answer.
      // eslint-disable-next-line no-await-in-loop
      const current = await checkAuthorityAt(
        tx,
        authority.subjects,
        {
          collection: authority.collection,
          action,
          scope: { kind: 'record', id: authority.taskId },
        },
        at,
      );
      if (!current.ok) {
        return refuse(
          'SCOPE_NOT_GRANTED',
          `the ${action} grant this cancellation rested on ended before it could be recorded`,
          `A person with ${action} authority on this task cancels its work.`,
        );
      }
    }
  }

  const updated = await tx.query<{ readonly task_id: string }>(
    `update public.proposal_lineages
        set state = 'cancelled', terminal_reason = $3, terminal_at = now()
      where business_id = $1 and id = $2 and state = 'live'
      returning task_id`,
    [tx.businessId, request.lineageId, request.reason],
  );
  if (updated[0] === undefined) return terminal;
  // T2h: the cancellation's one alert, on the lineage's task.
  await raiseAlert(tx, {
    taskId: updated[0].task_id,
    causeId: request.lineageId,
    raised: { kind: 'cancelled' },
  });

  await retireWork(tx, workAfter, locks);
  // Nothing in this head dispatches, so the ordinary cancellation completes as
  // cancelled (T5). A run already handed back keeps that outcome as history.
  for (const id of runsAfter) locks.require('run', id);
  await tx.query(
    `update public.planned_runs set state = 'cancelled'
      where business_id = $1 and id = any($2::uuid[]) and state in ('planned', 'claimed')`,
    [tx.businessId, runsAfter],
  );

  const classified = await classifyAll(tx, after, locks, (row) => ({
    reservationId: row.reservation_id,
    cause: 'lineage_cancelled',
    causeId: row.cause_id,
  }));
  return { ok: true, value: classified };
}
