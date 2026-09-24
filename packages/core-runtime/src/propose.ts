// SPDX-License-Identifier: AGPL-3.0-only
//
// T1: propose real bounded local work.
//
// One transaction. It locks the task context, checks the caller's write and
// proposal authority through L2's grants, creates the next immutable version,
// the real planned run and its step, renders the evidence pack from those
// stored facts, and creates the gate bound to all of them.
//
// Two things it does not do, and both are the contract rather than an omission.
// It does not create any accounting record: "required accounting records are
// created by the decision, not by a proposal pretending to be approved" (T1).
// And it does not approve anything, on any timer.
//
// A proposal beyond scope or budget authority returns the accepted refusal and
// changes nothing — which means the authority check happens before the first
// insert, not after it with a rollback, because a refusal that depends on a
// rollback is a refusal that a partial commit can turn into a success.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import { checkAuthority } from '../../core-records/src/authority/grants.ts';
import type { Subject } from '../../core-records/src/authority/grants.ts';
import { acquire, type LockSet } from './locks.ts';
import { only } from './only.ts';
import {
  AffectedSetChanged,
  affectedByVersions,
  classifyVersions,
  discoverLiveWork,
  liveWorkLocks,
  retireWork,
} from './recovery.ts';
import { writeProposal } from './proposal-writer.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

// The version, run, step, evidence pack and gate inserts moved to
// `proposal-writer.ts` so `handback` can make a successor through the same
// code rather than a second copy of it (T4). `roundsUsed` moved with them and
// is re-exported here, because `index.ts` pins it under this module's name and
// L3 imports it from there.
export { roundsUsed } from './proposal-writer.ts';

export interface ProposeRequest {
  readonly taskId: string;
  readonly collection: string;
  readonly proposedByActorId: string;
  readonly subjects: readonly Subject[];
  readonly purpose: string;
  /** The finite ceiling this proposal asks to be allowed to spend, in minor units. */
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payload: Record<string, unknown>;
  readonly step: { readonly kind: string; readonly payload: Record<string, unknown> };
  readonly expiresAt: Date;
  /** Present to add a version to a live lineage; absent to open one. */
  readonly lineageId?: string;
  /**
   * An authorised restart (G05): the rejected or cancelled lineage on this task
   * the new one is opened in place of. Only with `lineageId` absent. The old
   * lineage is locked, checked terminal and not already restarted under that
   * lock, and named in the new row's `restarts_lineage_id`; it is never
   * reopened, and nothing it held is reused.
   */
  readonly restartsLineageId?: string;
}

export interface Proposal {
  readonly lineageId: string;
  readonly versionId: string;
  readonly version: number;
  readonly runId: string;
  readonly stepId: string;
  readonly evidencePackId: string;
  readonly gateId: string;
  readonly payloadDigest: string;
}

interface LineageRow {
  readonly id: string;
  readonly state: string;
  readonly task_id: string;
}

/**
 * The ordered lock set a proposal needs, discovered read-only and then taken
 * in one `acquire` call (TRANSACTION-CONTRACT line 9). Split from the writes
 * so a command adapter can compare its own expected revision under these
 * locks rather than taking the task lock itself first (F1): an adapter lock on
 * the task before this cap and envelope is one half of a cycle with handback,
 * which takes cap, envelope, then task.
 */
export interface HeldProposal {
  readonly locks: LockSet;
  readonly lineageId: string | null;
  readonly restarts: string | null;
  readonly accounting: { readonly id: string; readonly cap_id: string } | null;
  readonly openingId: string;
  readonly liveWork: Awaited<ReturnType<typeof discoverLiveWork>>;
}

export async function propose(
  tx: TenantQuery,
  request: ProposeRequest,
): Promise<RuntimeResult<Proposal>> {
  return await proposeUnderLocks(tx, request, await lockProposal(tx, request));
}

export async function lockProposal(
  tx: TenantQuery,
  request: ProposeRequest,
): Promise<HeldProposal> {
  // The lineage, the task, and -- R8 -- every parent of the holds this proposal
  // is about to make nonclaimable. Supersession that leaves version 1's hold
  // consuming the envelope makes approving version 2 fail for room it is
  // entitled to, and discovering those accounting parents after the lineage
  // lock would be the backwards acquisition T5 forbids. Discovery first,
  // acquisition second, writes third.
  const lineageId = request.lineageId ?? null;
  const restarts = lineageId === null ? (request.restartsLineageId ?? null) : null;
  const liveVersions =
    lineageId === null
      ? []
      : (
          await tx.query<{ readonly id: string }>(
            `select id from public.proposal_versions
              where business_id = $1 and lineage_id = $2 and superseded_at is null`,
            [tx.businessId, lineageId],
          )
        ).map((row) => row.id);

  // The task's own accounting parents, when they exist. `writeProposal`
  // requires them because the version it writes is the version a later
  // decision draws on, and `affectedByVersions` above only finds them by way
  // of a hold that is still live -- an envelope whose holds are all terminal is
  // just as real and just as much the parent of this version. Discovered here,
  // before the locks, and taken in the same ordered call as everything else.
  const envelopes = await tx.query<{ readonly id: string; readonly cap_id: string }>(
    `select id, cap_id from public.task_envelopes
      where business_id = $1 and task_id = $2 and state = 'open'`,
    [tx.businessId, request.taskId],
  );
  const accounting = envelopes[0] ?? null;

  // T4's "preallocate any new successor identities before lock acquisition;
  // this is identity preparation, not a write or approval". A lineage opened by
  // this call has no row to lock yet, and taking its lock after the reservation
  // locks below would be the backwards acquisition the contract forbids. Its
  // identity is decided here instead, so the whole set is one ordered call and
  // `writeProposal` can require a lineage lock unconditionally.
  const openingId = randomUUID();
  // F3. The live version's own work -- a picked-up lease and its delegation --
  // is made obsolete by the version this call writes, so it is retired here
  // under the same ordered set rather than left able to settle.
  const liveWork = await discoverLiveWork(tx, { versionIds: liveVersions });
  const locks = await acquire(tx, [
    ...(accounting === null
      ? []
      : [
          { lockClass: 'cap' as const, id: accounting.cap_id },
          { lockClass: 'envelope' as const, id: accounting.id },
        ]),
    { lockClass: 'task', id: request.taskId },
    { lockClass: 'lineage', id: lineageId ?? openingId },
    ...(restarts === null ? [] : [{ lockClass: 'lineage' as const, id: restarts }]),
    ...(await affectedByVersions(tx, liveVersions)),
    ...liveWorkLocks(liveWork),
  ]);
  // Rechecked under the locks, before the first write. A lease picked up or
  // released in between is a set this transaction did not lock for.
  const liveNow = await discoverLiveWork(tx, { versionIds: liveVersions });
  if (JSON.stringify(liveNow) !== JSON.stringify(liveWork)) {
    throw new AffectedSetChanged(
      'propose: the live work on the superseded version changed under discovery; roll back and rediscover',
    );
  }
  return { locks, lineageId, restarts, accounting, openingId, liveWork };
}

/** The proposal's checks and writes, under the set `lockProposal` took. */
export async function proposeUnderLocks(
  tx: TenantQuery,
  request: ProposeRequest,
  held: HeldProposal,
): Promise<RuntimeResult<Proposal>> {
  const { locks, lineageId, restarts, accounting, openingId, liveWork } = held;
  // Authority, on both actions, read after the locks are held (T4: current
  // authority is re-read under the complete set). `write` is "you may change
  // this task"; `comment` would not be enough to commit a business to work,
  // and `decide` is deliberately not asked for -- proposing is not deciding.
  const readable = await requires(tx, request, 'read');
  if (readable !== null) return readable;
  const writable = await requires(tx, request, 'write');
  if (writable !== null) return writable;

  if (!Number.isSafeInteger(request.maximumMinor) || request.maximumMinor <= 0) {
    return refuse(
      'PROPOSAL_OUT_OF_SCOPE',
      `a bounded proposal needs a finite positive ceiling, and this one asks for ${request.maximumMinor}`,
      'Name a maximum in minor units greater than zero.',
    );
  }

  if (restarts !== null) {
    const refused = await refuseRestart(tx, restarts, request.taskId);
    if (refused !== undefined) return refused;
  }

  let lineage: LineageRow;
  if (lineageId === null) {
    const opened = await tx.query<LineageRow>(
      `insert into public.proposal_lineages
         (business_id, id, task_id, opened_by_actor_id, restarts_lineage_id)
       values ($1, $2, $3, $4, $5)
       returning id, state, task_id`,
      [tx.businessId, openingId, request.taskId, request.proposedByActorId, restarts],
    );
    lineage = only(opened, 'propose: the lineage inserted above');
  } else {
    const found = await tx.query<LineageRow>(
      `select id, state, task_id from public.proposal_lineages
        where business_id = $1 and id = $2`,
      [tx.businessId, lineageId],
    );
    const row = found[0];
    if (row === undefined) {
      // Ruling 2 of 906613f: `lineageId` is the caller's, so a lineage in
      // another business and one that names nothing get the same bytes. The
      // reason names neither, because the id was the only thing that differed.
      return refuse(
        'GATE_NOT_FOUND',
        'no proposal lineage with that id in this business',
        'Propose without a lineage to open a new one.',
      );
    }
    // R3. A lineage belongs to one task, and the authority checked above was
    // checked on `request.taskId`. Without this, a caller authorised on task A
    // could name a live lineage on task B in the same business, supersede B's
    // version under A's authority, and leave a run whose lineage and task
    // describe two different pieces of work. Tenancy does not prevent it:
    // both tasks are in one business.
    if (row.task_id !== request.taskId) {
      return refuse(
        'LINEAGE_NOT_ON_TASK',
        `lineage ${lineageId} belongs to task ${row.task_id}, not to the ${request.taskId} this proposal names`,
        'Propose against the task the lineage was opened on, or open a new lineage on this one.',
      );
    }
    // G05: a rejected or cancelled lineage stays terminal. A new version in it
    // would be work authorised by a line somebody closed.
    if (row.state !== 'live') {
      return refuse(
        'LINEAGE_TERMINAL',
        `lineage ${lineageId} is ${row.state}; a terminal lineage takes no further versions`,
        'An authorised restart opens a new lineage. It never reopens this one.',
      );
    }
    lineage = row;
  }

  const written = await writeProposal(
    tx,
    {
      taskId: request.taskId,
      lineageId: lineage.id,
      envelopeId: accounting?.id ?? null,
      capId: accounting?.cap_id ?? null,
      proposedByActorId: request.proposedByActorId,
      purpose: request.purpose,
      maximumMinor: request.maximumMinor,
      currency: request.currency,
      payload: request.payload,
      step: request.step,
      expiresAt: request.expiresAt,
    },
    locks,
  );
  if (!written.ok) return written;

  // R8. The hold the superseded version owns is released here, in the
  // transaction that made it nonclaimable, under the locks discovered for it
  // above. Leaving it for a later unrelated replay is what made the business-
  // wide sweep from cancellation look necessary.
  if (written.value.supersededVersionId !== null) {
    await retireWork(tx, liveWork, locks);
    await classifyVersions(
      tx,
      [written.value.supersededVersionId],
      'version_superseded',
      written.value.supersededVersionId,
      locks,
    );
  }

  return {
    ok: true,
    value: {
      lineageId: lineage.id,
      versionId: written.value.versionId,
      version: written.value.version,
      runId: written.value.runId,
      stepId: written.value.stepId,
      evidencePackId: written.value.evidencePackId,
      gateId: written.value.gateId,
      payloadDigest: written.value.payloadDigest,
    },
  };
}

/**
 * One authority check, refusing in the caller's words. Two calls rather than a
 * loop so each refusal names the action it was actually refused on.
 */
async function requires(
  tx: TenantQuery,
  request: ProposeRequest,
  action: 'read' | 'write',
): Promise<RuntimeResult<never> | null> {
  const decision = await checkAuthority(tx, request.subjects, {
    collection: request.collection,
    action,
    scope: { kind: 'record', id: request.taskId },
  });
  if (decision.ok) return null;
  return refuse(
    'SCOPE_NOT_GRANTED',
    `proposing bounded work on this task needs ${action} on it, and the caller holds no such grant`,
    'Ask for the grant, or propose against a task the caller already holds it on.',
  );
}

/**
 * Why a restart of `restarts` is refused, under its lineage lock, or nothing.
 *
 * Terminal means rejected or cancelled: a live lineage is continued with a new
 * version, not restarted, and a completed one finished its work. One restart
 * per terminal lineage, because the restart *is* the owner's answer to that
 * line ending; a second one would be two lines of work authorised by one
 * choice. A lineage on another task is the R3 refusal `propose` already gives.
 */
async function refuseRestart(
  tx: TenantQuery,
  restarts: string,
  taskId: string,
): Promise<RuntimeResult<never> | undefined> {
  const rows = await tx.query<{
    readonly state: string;
    readonly task_id: string;
    readonly successor: string | null;
  }>(
    `select lin.state, lin.task_id,
            (select next.id from public.proposal_lineages next
              where next.business_id = lin.business_id and next.restarts_lineage_id = lin.id
              limit 1) as successor
       from public.proposal_lineages lin
      where lin.business_id = $1 and lin.id = $2`,
    [tx.businessId, restarts],
  );
  const row = rows[0];
  if (row === undefined) {
    return refuse(
      'GATE_NOT_FOUND',
      'no such proposal lineage in this business',
      'Name the rejected or cancelled lineage this restart replaces.',
    );
  }
  if (row.task_id !== taskId) {
    return refuse(
      'LINEAGE_NOT_ON_TASK',
      `lineage ${restarts} belongs to task ${row.task_id}, not to ${taskId}`,
      'Restart a lineage on the task it was opened on.',
    );
  }
  if (row.state !== 'rejected' && row.state !== 'cancelled') {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      `lineage ${restarts} is ${row.state}; only a rejected or cancelled lineage is restarted`,
      'Propose a new version on a live lineage instead.',
    );
  }
  if (row.successor !== null) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      `lineage ${restarts} was already restarted as ${row.successor}`,
      'Work on the lineage the first restart opened.',
    );
  }
  return undefined;
}
