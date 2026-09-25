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
import { readBusinessCapId } from '../../core-records/src/commands/runtime-config.ts';
import { capCommitted, exceeds, openEnvelopeOf } from './budget.ts';
import type { LockSet } from './locks.ts';
import { only, RuntimeInvariantError } from './only.ts';
import {
  affectedByVersions,
  classifyVersions,
  discoverLiveWork,
  liveWorkLocks,
  retireWork,
} from './recovery.ts';
import { writeProposal } from './proposal-writer.ts';
import { lockRediscovered } from './rediscovery.ts';
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
  /**
   * The cap a task with no open envelope would draw on, as `decide` reads it
   * (`readBusinessCapId`). T1 validates existing budget authority at the
   * proposal, so the proposal needs the cap before its first write; a task
   * with an open envelope is checked against that envelope's own cap instead.
   * Absent, `lockProposal` reads the business cap itself (R2-RUNTIME-26
   * residual (b), `restart`); with no cap at all and no envelope open there is
   * no ceiling to check against here, and the decision answers
   * `BUDGET_UNAVAILABLE`.
   */
  readonly capId?: string;
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
  /** The cap the budget check reads: the envelope's, else the request's `capId`. */
  readonly capId: string | null;
  /** The lineage's live versions, read under the locks: the ones this proposal supersedes. */
  readonly liveVersions: readonly string[];
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
  // Final review round 3, R3-AUTHORITY-19: the caller's lineage id is the lock
  // key, and `writeProposal` requires the lineage by the database's own
  // lower-case id. An upper-case spelling of the same uuid found the lineage
  // through the cast and then faulted at the lock-set check (R2-AUTHORITY-33).
  const lineageId = request.lineageId?.toLowerCase() ?? null;
  const restarts = lineageId === null ? (request.restartsLineageId?.toLowerCase() ?? null) : null;
  // T4's "preallocate any new successor identities before lock acquisition;
  // this is identity preparation, not a write or approval". A lineage opened by
  // this call has no row to lock yet, and taking its lock after the reservation
  // locks below would be the backwards acquisition the contract forbids. Its
  // identity is decided here instead, so the whole set is one ordered call and
  // `writeProposal` can require a lineage lock unconditionally.
  const openingId = randomUUID();
  // Everything the set is built from is read inside `discover`, so all of it is
  // read again under the locks and compared. Final review round 2,
  // R2-RUNTIME-25: the live version itself was read once, outside, so a
  // version proposed and approved in the window was superseded under locks
  // never taken for its hold, and the classifier met that hold as a plain
  // lock-order `Error`. RUNTIME.md "an approval ... between a proposal's
  // discovery and its locks costs one retry": the recheck has to see which
  // version is live, not only what the first-found version holds.
  //
  // - The live versions: the lineage's `superseded_at is null` rows.
  // - The task's own accounting parents, when they exist. `writeProposal`
  //   requires them because the version it writes is the version a later
  //   decision draws on, and `affectedByVersions` only finds them by way of a
  //   hold that is still live -- an envelope whose holds are all terminal is
  //   just as real and just as much the parent of this version.
  // - F3. The live version's own work -- a picked-up lease and its delegation
  //   -- is made obsolete by the version this call writes, so it is retired
  //   here under the same ordered set rather than left able to settle.
  // - R8. Every parent of the holds this proposal is about to make
  //   nonclaimable. Supersession that leaves version 1's hold consuming the
  //   envelope makes approving version 2 fail for room it is entitled to, and
  //   discovering those parents after the lineage lock would be the backwards
  //   acquisition T5 forbids.
  //
  // Thermo O3: a lease picked up or released in between, or a hold an approval
  // of the superseded version opened, is a set this transaction did not lock
  // for, and it rolls back as `AffectedSetChanged` rather than extend it.
  // Discovery first, acquisition second, writes third.
  const {
    locks,
    found: [liveVersions, envelope, liveWork, , businessCap],
  } = await lockRediscovered(tx, {
    discover: async () => {
      const versions =
        lineageId === null
          ? []
          : (
              await tx.query<{ readonly id: string }>(
                `select id from public.proposal_versions
                  where business_id = $1 and lineage_id = $2 and superseded_at is null
                  order by id`,
                [tx.businessId, lineageId],
              )
            ).map((row) => row.id);
      const open = await openEnvelopeOf(tx, request.taskId);
      return [
        versions,
        open === undefined ? null : { id: open.id, cap_id: open.capId },
        await discoverLiveWork(tx, { versionIds: versions }),
        await affectedByVersions(tx, versions),
        // R2-RUNTIME-26 residual (b): a caller that passes no cap, which is
        // `restart`, is checked against the cap `decide` would draw on, as
        // `task.propose` is. Read here so it is locked and rechecked with the set.
        request.capId ?? (await readBusinessCapId(tx)),
      ] as const;
    },
    locks: ([, open, work, held, business]) => {
      const capId = open?.cap_id ?? business;
      return [
        ...(capId === undefined ? [] : [{ lockClass: 'cap' as const, id: capId }]),
        ...(open === null ? [] : [{ lockClass: 'envelope' as const, id: open.id }]),
        { lockClass: 'task', id: request.taskId },
        { lockClass: 'lineage', id: lineageId ?? openingId },
        ...(restarts === null ? [] : [{ lockClass: 'lineage' as const, id: restarts }]),
        ...held,
        ...liveWorkLocks(work),
      ];
    },
    rule: 'exact',
    changed:
      'propose: the live work on the superseded version, its holds, the live version itself or the task envelope changed under discovery; roll back and rediscover',
  });
  const accounting = envelope;
  const capId = accounting?.cap_id ?? businessCap ?? null;
  return { locks, lineageId, restarts, accounting, capId, liveVersions, openingId, liveWork };
}

/** The proposal's checks and writes, under the set `lockProposal` took. */
export async function proposeUnderLocks(
  tx: TenantQuery,
  request: ProposeRequest,
  held: HeldProposal,
): Promise<RuntimeResult<Proposal>> {
  const { locks, lineageId, restarts, accounting, capId, liveVersions, openingId, liveWork } = held;
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

  let lineage: LineageRow | undefined;
  if (lineageId !== null) {
    const found = await tx.query<LineageRow>(
      `select id, state, task_id from public.proposal_lineages
        where business_id = $1 and id = $2`,
      [tx.businessId, lineageId],
    );
    const row = found[0];
    if (row === undefined) {
      // Ruling 2 of dd30aa8: `lineageId` is the caller's, so a lineage in
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
      // Final review round 2, R2-AUTHORITY-34: the reason is the rule's, not
      // the caller's data. The other task may be outside the caller's grant,
      // so neither its id nor the presented lineage id is echoed.
      return refuse(
        'LINEAGE_NOT_ON_TASK',
        'that lineage was opened on another task, not on the task this proposal names',
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

  // Final review round 3, R3-AUTHORITY-20: after a named lineage is known to be
  // on this task and live, and before any write. Priced first, a lineage on another task released that
  // task's hold into the refusal's committed figure, and whether the answer
  // was LINEAGE_NOT_ON_TASK depended on the ceiling.
  const outOfBudget = await refuseBeyondBudget(
    tx,
    request,
    capId,
    accounting?.id ?? null,
    liveVersions,
  );
  if (outOfBudget !== null) return outOfBudget;

  // The first write: a new lineage opens only once every refusal has passed.
  if (lineage === undefined) {
    const opened = await tx.query<LineageRow>(
      `insert into public.proposal_lineages
         (business_id, id, task_id, opened_by_actor_id, restarts_lineage_id)
       values ($1, $2, $3, $4, $5)
       returning id, state, task_id`,
      [tx.businessId, openingId, request.taskId, request.proposedByActorId, restarts],
    );
    lineage = only(opened, 'propose: the lineage inserted above');
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
 * T1's "validate ... existing budget authority" (TRANSACTION-CONTRACT lines 44
 * and 46), under the locks and before the first write. Final review round 2,
 * R2-RUNTIME-26: a version in another currency than the cap, or asking more
 * than the cap has room for, was written with a gate every approval of which
 * is refused, until it expired. The handback successor already refused the
 * same operands (`withinBounds` in `handback.ts`); this is the same two checks.
 *
 * The room excludes what the superseded version still holds: that hold is
 * released by this transaction, so a new version of an approved lineage may
 * ask for the room its predecessor gives back. With no cap to read (no envelope
 * and no `capId`), there is no ceiling here, and the decision answers
 * `BUDGET_UNAVAILABLE`.
 *
 * Final review round 3, SOL-R3-3: the open envelope is authority too, and
 * `budgetRoom` in `decide.ts` asks it before the cap. A ceiling within the cap
 * but past the envelope's room, less the superseded version's own hold in it,
 * was written with a gate every approval refused `BUDGET_UNAVAILABLE`. The
 * envelope was locked and rediscovered exactly with the rest of the set, so
 * the envelope read here is the one `accounting` names.
 */
async function refuseBeyondBudget(
  tx: TenantQuery,
  request: ProposeRequest,
  capId: string | null,
  envelopeId: string | null,
  liveVersions: readonly string[],
): Promise<RuntimeResult<never> | null> {
  if (capId === null) return null;
  const cap = await capCommitted(tx, capId);
  if (cap === undefined) {
    throw new RuntimeInvariantError(`refuseBeyondBudget: no cap ${capId} behind a locked set`);
  }
  if (request.currency !== cap.currency) {
    return refuse(
      'PROPOSAL_OUT_OF_SCOPE',
      `this task's budget cap is in ${cap.currency}, and a proposal in another currency is outside it`,
      'Propose the work in the currency the cap holds.',
    );
  }
  const { released, fromEnvelope } =
    liveVersions.length === 0
      ? { released: '0', fromEnvelope: '0' }
      : await tx
          .query<{ readonly released: string; readonly from_envelope: string }>(
            `select coalesce(sum(held_minor), 0)::text as released,
                    coalesce(sum(held_minor) filter (where envelope_id = $3), 0)::text as from_envelope
               from public.reservations
              where business_id = $1 and state = 'held' and version_id = any($2::uuid[])`,
            [tx.businessId, liveVersions, envelopeId],
          )
          .then((rows) => ({
            released: rows[0]?.released ?? '0',
            fromEnvelope: rows[0]?.from_envelope ?? '0',
          }));
  if (envelopeId !== null) {
    const pastEnvelope = await refuseBeyondEnvelope(tx, request, envelopeId, fromEnvelope);
    if (pastEnvelope !== null) return pastEnvelope;
  }
  const committed = String(BigInt(cap.committed) - BigInt(released));
  if (exceeds(committed, BigInt(request.maximumMinor), cap.limitMinor)) {
    return refuse(
      'PROPOSAL_OUT_OF_SCOPE',
      `the budget cap behind this task has ${committed} of ${cap.limitMinor} committed, and this ceiling does not fit its remaining room`,
      'Propose a ceiling within the cap, or raise the cap through its own authorised decision.',
    );
  }
  return null;
}

/**
 * SOL-R3-3's half of `refuseBeyondBudget`: the task's open envelope, which
 * `budgetRoom` asks before the cap. `fromEnvelope` is what the superseded
 * version holds in it, released by this transaction.
 */
async function refuseBeyondEnvelope(
  tx: TenantQuery,
  request: ProposeRequest,
  envelopeId: string,
  fromEnvelope: string,
): Promise<RuntimeResult<never> | null> {
  // By the locked id, not by task: `openEnvelopeOf` is the discovery read, and
  // this is a read under the lock of what discovery found.
  const envelope = (
    await tx.query<{
      readonly currency: string;
      readonly maximum_minor: string;
      readonly held_minor: string;
      readonly actual_minor: string;
    }>(
      `select currency, maximum_minor::text as maximum_minor, held_minor::text as held_minor,
              actual_minor::text as actual_minor
         from public.task_envelopes where business_id = $1 and id = $2 and state = 'open'`,
      [tx.businessId, envelopeId],
    )
  )[0];
  if (envelope === undefined) {
    throw new RuntimeInvariantError(
      `refuseBeyondEnvelope: the locked envelope ${envelopeId} is not open under its lock`,
    );
  }
  if (request.currency !== envelope.currency) {
    return refuse(
      'PROPOSAL_OUT_OF_SCOPE',
      `this task's envelope is in ${envelope.currency}, and a proposal in another currency is outside it`,
      'Propose the work in the currency the envelope holds.',
    );
  }
  const inEnvelope = String(
    BigInt(envelope.held_minor) + BigInt(envelope.actual_minor) - BigInt(fromEnvelope),
  );
  if (exceeds(inEnvelope, BigInt(request.maximumMinor), envelope.maximum_minor)) {
    return refuse(
      'PROPOSAL_OUT_OF_SCOPE',
      `this task's envelope has ${inEnvelope} of ${envelope.maximum_minor} committed, and this ceiling does not fit its remaining room`,
      'Propose a ceiling within the envelope, or raise it through its authorised boundary.',
    );
  }
  return null;
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
