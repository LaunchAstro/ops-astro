// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's `receipt written`: the observed publish or revert result and its
// receipt, in one transaction under a live worker lease on the correction's
// task that the caller holds, inside a live delegation where the lease has
// one. If the receipt cannot be written, the state does not move.
//
// The runner's read of the correction it is about to act on is here too, under
// the same lease check, so the read and the write ask one question.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  lockCorrectionForSystem,
  type CorrectionState,
  type LiveCorrection,
} from './live-corrections.ts';

export type ReceiptOutcome = 'accepted' | 'live' | 'unknown' | 'failed' | 'reverted';

/** Where the worker stands: the correction, the lease it holds, its fence and its own actor. */
export interface UnderLease {
  readonly correctionId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly actorId: string;
}

export interface ObservedResult extends UnderLease {
  readonly step: 'publish' | 'revert';
  readonly outcome: ReceiptOutcome;
  readonly observations: Readonly<Record<string, unknown>>;
}

/** The states each step may move from. A publish needs the approval; a revert a live page. */
const FROM: Readonly<Record<ObservedResult['step'], readonly CorrectionState[]>> = {
  publish: ['approved', 'accepted', 'unknown'],
  revert: ['live'],
};

/**
 * A decided correction cancelled after its dispatch: the runner saw the cancel during the
 * publish, or the cancel landed during its read-back. Either way the publish may be out, an
 * uncertain effect (`core-connectors/src/site/publish.ts`), so the row takes any publish
 * result, its receipt keeps the observed outcome, and it is recorded unknown. A request
 * cancelled before any decision was never dispatched and takes none.
 */
const cancelledAfterDispatch = (result: ObservedResult, correction: LiveCorrection): boolean =>
  correction.state === 'cancelled' &&
  correction.decidedByPersonId !== null &&
  result.step === 'publish';

/** Whether the result may move `correction`: from its step's states, or cancelled after dispatch. */
const movesFrom = (result: ObservedResult, correction: LiveCorrection): boolean =>
  FROM[result.step].includes(correction.state) || cancelledAfterDispatch(result, correction);

/**
 * The state a result moves to. A publish takes its outcome, but a cancelled correction's
 * is recorded unknown; a revert moves only once the original word is observed back, so a
 * revert accepted, unknown or failed leaves the page recorded live, with its receipt
 * saying why.
 */
function nextState(result: ObservedResult, correction: LiveCorrection): CorrectionState {
  if (cancelledAfterDispatch(result, correction)) return 'unknown';
  if (result.step === 'publish' || result.outcome === 'reverted') return result.outcome;
  return 'live';
}

export type ObservedRefusal = 'LEASE_NOT_OWNED' | 'NOT_FOUND' | 'GATE_NOT_APPROVED';

type Held = { readonly ok: true; readonly correction: LiveCorrection } | Refused;
type Refused = { readonly ok: false; readonly code: ObservedRefusal };

/**
 * The correction locked, and a live worker lease on its task at the fence the
 * worker holds, or the refusal. The lease and then its delegation are locked
 * `for share` (`core-runtime/src/locks.ts`'s order), so neither can end or be
 * revoked until this transaction does; then the clock is read once, after the
 * locks, and both expiries are judged at it (`core-runtime/src/clock.ts`), so a
 * write that waited on the correction past an expiry sees it expired. The lease
 * is the caller's own, and its delegation, where it has one, is not revoked,
 * settled or expired: the check `core-runtime/src/lease-ownership.ts` makes.
 */
async function holdUnderLease(tx: TenantQuery, at: UnderLease): Promise<Held> {
  const correction = await lockCorrectionForSystem(tx, at.correctionId);
  if (correction === undefined) return { ok: false, code: 'NOT_FOUND' };
  const [lease] = await tx.query<{ readonly delegation_id: string | null }>(
    `select l.delegation_id from public.leases l
      where l.business_id = $1 and l.id = $2 and l.task_id = $3 and l.fence = $4
        and l.holder_actor_id = $5
      for share of l`,
    [tx.businessId, at.leaseId, correction.taskId, at.fence, at.actorId],
  );
  if (lease === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  if (lease.delegation_id !== null) {
    await tx.query(
      `select 1 from public.delegations where business_id = $1 and id = $2 for share`,
      [tx.businessId, lease.delegation_id],
    );
  }
  const live = await tx.query<{ readonly id: string }>(
    `with instant as materialized (select clock_timestamp() as at)
     select l.id from public.leases l, instant
      where l.business_id = $1 and l.id = $2 and l.state = 'live' and l.expires_at > instant.at
        and (l.delegation_id is null or exists (
              select 1 from public.delegations d
               where d.business_id = l.business_id and d.id = l.delegation_id
                 and d.revoked_at is null and d.settled_at is null and d.expires_at > instant.at))`,
    [tx.businessId, at.leaseId],
  );
  if (live.length === 0) return { ok: false, code: 'LEASE_NOT_OWNED' };
  return { ok: true, correction };
}

export interface HeldForRun {
  readonly ok: true;
  readonly correction: LiveCorrection;
  /** The latest publish receipt's observations, when there is one. */
  readonly lastPublish: Readonly<Record<string, unknown>> | undefined;
}

/** The runner's read: the correction and its last publish receipt, under the worker lease. */
export async function readCorrectionForRun(
  tx: TenantQuery,
  at: UnderLease,
): Promise<HeldForRun | Refused> {
  const held = await holdUnderLease(tx, at);
  if (!held.ok) return held;
  const receipts = await tx.query<{ readonly observations: Record<string, unknown> }>(
    `select observations from public.live_correction_receipts
      where business_id = $1 and correction_id = $2 and step = 'publish'
      order by created_at desc, id desc limit 1`,
    [tx.businessId, at.correctionId],
  );
  return { ok: true, correction: held.correction, lastPublish: receipts[0]?.observations };
}

/**
 * `receipt written`: the observed result and its receipt, together. The receipt
 * keeps the outcome observed; a decided correction cancelled after its dispatch
 * still takes it, and moves to unknown.
 *
 * Under a live worker lease the caller holds on the correction's task with the
 * fence it holds, both locked; the correction row locked first. The state moves and the
 * receipt is appended in this transaction, so a receipt that fails to write
 * leaves no moved state behind it, and a state never moves without its receipt.
 */
export async function recordObservedResult(
  tx: TenantQuery,
  result: ObservedResult,
): Promise<
  { readonly ok: true; readonly receiptId: string; readonly state: CorrectionState } | Refused
> {
  const held = await holdUnderLease(tx, result);
  if (!held.ok) return held;
  if (!movesFrom(result, held.correction)) return { ok: false, code: 'GATE_NOT_APPROVED' };

  const state = nextState(result, held.correction);
  await tx.query(
    `update public.live_corrections
        set state = $3, revision = revision + 1, updated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, result.correctionId, state],
  );
  const receiptId = randomUUID();
  await tx.query(
    `insert into public.live_correction_receipts
       (business_id, id, correction_id, lease_id, fence, step, outcome, observations)
     values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)`,
    [
      tx.businessId,
      receiptId,
      result.correctionId,
      result.leaseId,
      result.fence,
      result.step,
      result.outcome,
      JSON.stringify(result.observations),
    ],
  );
  return { ok: true, receiptId, state };
}
