// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's `receipt written`: the observed publish or revert result and its
// receipt, in one transaction under a live worker lease on the correction's
// task that the caller holds, inside a live delegation where the lease has
// one, whose delegating person still holds the write it draws on, those grants
// held until the receipt commits. If the receipt cannot be written, the state
// does not move.
//
// The runner's read of the correction it is about to act on is here too, under
// the same lease check, so the read and the write ask one question.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { checkDelegatedAuthority, resolveLiveById } from '../authority/delegations.ts';
import type { Delegation } from '../authority/delegations.ts';
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

export type ObservedRefusal =
  'LEASE_NOT_OWNED' | 'DELEGATION_NARROWED' | 'NOT_FOUND' | 'GATE_NOT_APPROVED';

type Held = { readonly ok: true; readonly correction: LiveCorrection } | Refused;
type Refused = { readonly ok: false; readonly code: ObservedRefusal };

type OwnedLease = { readonly task_id: string; readonly delegation_id: string | null };

/**
 * The correction locked, and a live worker lease on its task at the fence the
 * worker holds, or the refusal: no such lease of the caller's is
 * `LEASE_NOT_OWNED` whatever the id; a correction absent or on another task,
 * `NOT_FOUND`. The lease and then its delegation are locked
 * `for share` (`core-runtime/src/locks.ts`'s order), so neither can end or be
 * revoked until this transaction does; then the clock is read once, after the
 * locks, and both expiries are judged at it (`core-runtime/src/clock.ts`), so a
 * write that waited on the correction past an expiry sees it expired. The lease
 * is the caller's own, and its delegation, where it has one, is not revoked,
 * settled or expired: the check `core-runtime/src/lease-ownership.ts` makes.
 * A delegated lease then stands on its person's grants (`delegatedWriteStands`),
 * share-locked before any of these (`holdPersonWrites`) for the delegation the
 * locked lease still names.
 */
async function holdUnderLease(tx: TenantQuery, at: UnderLease): Promise<Held> {
  // The lease the caller holds names the one task it may reach, asked before any correction:
  // another task's correction and an id that names none get the same answer.
  const [owned] = await tx.query<OwnedLease>(
    `select l.task_id, l.delegation_id from public.leases l
      where l.business_id = $1 and l.id = $2 and l.fence = $3 and l.holder_actor_id = $4`,
    [tx.businessId, at.leaseId, at.fence, at.actorId],
  );
  if (owned === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  const person =
    owned.delegation_id === null
      ? null
      : await holdPersonWrites(tx, at.actorId, owned.delegation_id);
  if (person === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  const correction = await lockCorrectionForSystem(tx, at.correctionId, owned.task_id);
  if (correction === undefined) return { ok: false, code: 'NOT_FOUND' };
  const [lease] = await tx.query<{ readonly delegation_id: string | null }>(
    `select l.delegation_id from public.leases l
      where l.business_id = $1 and l.id = $2 and l.task_id = $3 and l.fence = $4
        and l.holder_actor_id = $5
      for share of l`,
    [tx.businessId, at.leaseId, correction.taskId, at.fence, at.actorId],
  );
  if (lease === undefined || lease.delegation_id !== owned.delegation_id) {
    return { ok: false, code: 'LEASE_NOT_OWNED' };
  }
  if (lease.delegation_id !== null) {
    await tx.query(
      `select 1 from public.delegations where business_id = $1 and id = $2 for share`,
      [tx.businessId, lease.delegation_id],
    );
  }
  const live = await tx.query<{ readonly at: string }>(
    `with instant as materialized (select clock_timestamp() as at)
     select instant.at::text as at from public.leases l, instant
      where l.business_id = $1 and l.id = $2 and l.state = 'live' and l.expires_at > instant.at
        and (l.delegation_id is null or exists (
              select 1 from public.delegations d
               where d.business_id = l.business_id and d.id = l.delegation_id
                 and d.revoked_at is null and d.settled_at is null and d.expires_at > instant.at))`,
    [tx.businessId, at.leaseId],
  );
  const [instant] = live;
  if (instant === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  if (person !== null) {
    const stands = await delegatedWriteStands(tx, person, instant.at);
    if (!stands.ok) return stands;
  }
  return { ok: true, correction };
}

interface PersonHeld {
  readonly delegation: Delegation;
  readonly held: readonly string[];
}

/**
 * The live delegation, and the ids of the grants `checkDelegatedAuthority`
 * reads for it share-locked, with their parents, in id order in one statement:
 * the person's writes on its collections, at the business or its purpose record
 * (a child draws on its parent's person; both fixed at mint, 0100). Grant rows
 * come first (`core-runtime/src/locks.ts`), as `grant.revoke` takes its own: a
 * revocation that committed first is seen after the locks, a later one waits
 * for the commit, and a grant issued after this statement is not held.
 */
async function holdPersonWrites(
  tx: TenantQuery,
  actorId: string,
  delegationId: string,
): Promise<PersonHeld | undefined> {
  const delegation = await resolveLiveById(tx, actorId, delegationId);
  if (delegation === undefined) return undefined;
  const rows = await tx.query<{ readonly id: string }>(
    `with recursive chain as (
       select g.id, g.parent_grant_id from public.grants g
        where g.business_id = $1 and g.subject_kind = 'person' and g.subject_id = $2
          and g.collection = any($3::text[]) and g.action = 'write'
          and (g.scope_kind = 'business' or (g.scope_kind = $4 and g.scope_id = $5::uuid))
       union
       select p.id, p.parent_grant_id from public.grants p
         join chain c on p.id = c.parent_grant_id
        where p.business_id = $1
     )
     select g.id from public.grants g
      where g.business_id = $1 and g.id in (select id from chain)
      order by g.id
      for share`,
    [
      tx.businessId,
      delegation.delegatePersonId,
      delegation.collections,
      delegation.purposeScope.kind,
      delegation.purposeScope.id,
    ],
  );
  return { delegation, held: rows.map((row) => row.id) };
}

/**
 * A delegation's expiry is the lease's, not its person's earliest grant's, so
 * between the two the worker is narrowed (`docs/local/AUTHORITY.md`): a grant
 * revoked or past its own expiry refuses the worker's next read or write, as
 * it refuses the agent's next call. Asked through `checkDelegatedAuthority`,
 * the check a call makes, for write on every collection the delegation
 * carries on its purpose record; any one gone is `DELEGATION_NARROWED`. The
 * grants it answers are judged again at `at`, the instant read after the
 * locks, so a grant that lapsed while the caller waited no longer counts
 * (`core-runtime/src/recovery/classifier.ts`, `checkAuthorityAt`). Only
 * grants `held` count, so the answer stands until commit.
 */
async function delegatedWriteStands(
  tx: TenantQuery,
  { delegation, held }: PersonHeld,
  at: string,
): Promise<{ readonly ok: true } | Refused> {
  for (const collection of delegation.collections) {
    // Sequential: one transaction, one connection.
    // oxlint-disable-next-line no-await-in-loop
    const reach = await checkDelegatedAuthority(tx, delegation, {
      collection,
      action: 'write',
      scope: delegation.purposeScope,
    });
    if (!reach.ok) return { ok: false, code: 'DELEGATION_NARROWED' };
    // oxlint-disable-next-line no-await-in-loop
    const live = await tx.query<{ readonly id: string }>(
      `select id from public.grants
        where business_id = $1 and id = any($2::uuid[])
          and (expires_at is null or expires_at > $3::timestamptz)`,
      [tx.businessId, reach.value.filter((id) => held.includes(id)), at],
    );
    if (live.length === 0) return { ok: false, code: 'DELEGATION_NARROWED' };
  }
  return { ok: true };
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
