// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's `receipt written`: the observed publish or revert result and its
// receipt, in one transaction under a live worker lease on the correction's
// task. If the receipt cannot be written, the state does not move.
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

export interface ObservedResult {
  readonly correctionId: string;
  readonly leaseId: string;
  readonly fence: number;
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
 * The state a result moves to. A publish takes its outcome; a revert moves only
 * once the original word is observed back, so a revert accepted, unknown or
 * failed leaves the page recorded live, with its receipt saying why.
 */
function nextState(result: ObservedResult): CorrectionState {
  if (result.step === 'publish' || result.outcome === 'reverted') return result.outcome;
  return 'live';
}

export type ObservedRefusal = 'LEASE_NOT_OWNED' | 'NOT_FOUND' | 'GATE_NOT_APPROVED';

type Held = { readonly ok: true; readonly correction: LiveCorrection } | Refused;
type Refused = { readonly ok: false; readonly code: ObservedRefusal };

/**
 * The correction locked, and a live worker lease on its task at the fence the
 * worker holds (under a share lock, so the lease cannot end until this
 * transaction does), or the refusal.
 */
async function holdUnderLease(
  tx: TenantQuery,
  at: { readonly correctionId: string; readonly leaseId: string; readonly fence: number },
): Promise<Held> {
  const correction = await lockCorrectionForSystem(tx, at.correctionId);
  if (correction === undefined) return { ok: false, code: 'NOT_FOUND' };
  const lease = await tx.query<{ readonly id: string }>(
    `select id from public.leases
      where business_id = $1 and id = $2 and task_id = $3 and fence = $4
        and state = 'live' and expires_at > now()
      for share`,
    [tx.businessId, at.leaseId, correction.taskId, at.fence],
  );
  if (lease.length === 0) return { ok: false, code: 'LEASE_NOT_OWNED' };
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
  at: { readonly correctionId: string; readonly leaseId: string; readonly fence: number },
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
 * `receipt written`: the observed result and its receipt, together.
 *
 * Under a live worker lease on the correction's task with the fence the worker
 * holds, both locked; the correction row locked first. The state moves and the
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
  if (!FROM[result.step].includes(held.correction.state))
    return { ok: false, code: 'GATE_NOT_APPROVED' };

  const state = nextState(result);
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
