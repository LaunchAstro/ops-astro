// SPDX-License-Identifier: AGPL-3.0-only
//
// The production proposal writer, as a helper rather than as an entry point.
//
// T4 requires a handback that creates its successor proposal and pending gate
// "in this same transaction through a lock-aware production proposal writer",
// and then says what that writer may not be: it "must not invoke the external
// `task.propose` wrapper or acquire an earlier-class lock after the lease
// lock". Those two sentences rule out both of the obvious shortcuts. Calling
// `propose` from `handback` would re-run the authority check against the wrong
// subject, open its own lock set part-way through a transaction that already
// holds a later class, and take the lineage lock after the lease. Copying the
// insert statements into `handback.ts` would give the head two proposal
// writers that drift.
//
// So the writes themselves live here, once, and the locks are an argument. The
// caller has already discovered its parents and taken the complete set in the
// global order; this function asserts the four it depends on and takes none.
// `LockSet.require` throws rather than refuses, because a caller reaching
// outside its own lock set is a bug in that caller and not an answer about
// authority.
//
// Which four, and why each:
//
//   `task`      the run it writes is bound to the task, and 0017's composite
//               key binds the run's lineage to that same task.
//   `lineage`   it supersedes the lineage's live version and writes the next
//               one; this is the "proposal-lineage coordination" lock, and the
//               one-live-version index is the second barrier behind it.
//   `cap`       and
//   `envelope`  the accounting parents a later decision binds this version to.
//               They are required when they already exist, because a version
//               created outside them is a version a concurrent classification
//               or decision cannot see coming. A task with no envelope yet has
//               nothing to lock and passes `null`, which is a stated absence
//               rather than an omitted argument.
//
// It opens no transaction and commits nothing. Its caller's transaction is the
// unit: the successor either commits with the settlement that created it or
// does not exist.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import type { LockSet } from './locks.ts';
import { digestOf } from './signing.ts';
import { renderEvidence } from './evidence.ts';
import { type RuntimeResult } from './refusals.ts';

export interface ProposalWrite {
  readonly taskId: string;
  /** The lineage this version joins. Its row is locked by the caller, or created by it. */
  readonly lineageId: string;
  /** The accounting parents a decision will bind this version to, or `null` when none exists yet. */
  readonly envelopeId: string | null;
  readonly capId: string | null;
  readonly proposedByActorId: string;
  readonly purpose: string;
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payload: Record<string, unknown>;
  readonly step: { readonly kind: string; readonly payload: Record<string, unknown> };
  readonly expiresAt: Date;
}

export interface WrittenProposal {
  readonly versionId: string;
  readonly version: number;
  readonly runId: string;
  readonly stepId: string;
  readonly evidencePackId: string;
  readonly gateId: string;
  readonly payloadDigest: string;
  /**
   * The version this one superseded, or `null` when the lineage had none. The
   * caller classifies that version's hold under its own locks: the release is
   * an accounting fact, and this writer writes no accounting.
   */
  readonly supersededVersionId: string | null;
}

/**
 * The version, run, step, evidence pack and pending gate, in one lock-aware
 * write. Refuses only what `renderEvidence` refuses; every other precondition
 * is the caller's, checked before it called.
 */
export async function writeProposal(
  tx: TenantQuery,
  request: ProposalWrite,
  locks: LockSet,
): Promise<RuntimeResult<WrittenProposal>> {
  locks.require('task', request.taskId);
  locks.require('lineage', request.lineageId);
  if (request.capId !== null) locks.require('cap', request.capId);
  if (request.envelopeId !== null) locks.require('envelope', request.envelopeId);

  // Supersede the live version and, with it, the gate that was bound to it.
  // Doing this before the insert is what the one-live-version index requires,
  // and it is also G04: the earlier approval stays in the chain as history and
  // stops being able to authorise anything.
  const superseded = await tx.query<{ readonly id: string }>(
    `update public.proposal_versions set superseded_at = now()
      where business_id = $1 and lineage_id = $2 and superseded_at is null
      returning id`,
    [tx.businessId, request.lineageId],
  );
  const previous = superseded[0];
  let round = 1;
  if (previous !== undefined) {
    const rounds = await tx.query<{ readonly used: string }>(
      `update public.gates set state = 'superseded', decided_at = now()
        where business_id = $1 and version_id = $2 and state = 'pending'
        returning round::text as used`,
      [tx.businessId, previous.id],
    );
    // A superseding version continues the lineage's round count: G08 caps the
    // formal rounds across the lineage, not per gate, so resetting here would
    // make a third round reachable by proposing again.
    const carried = rounds[0];
    round = carried === undefined ? await roundsUsed(tx, request.lineageId) : Number(carried.used);
  }

  const versionNumbers = await tx.query<{ readonly next: string }>(
    `select coalesce(max(version), 0) + 1 as next from public.proposal_versions
      where business_id = $1 and lineage_id = $2`,
    [tx.businessId, request.lineageId],
  );
  const version = Number(versionNumbers[0]?.next ?? 1);

  const payloadDigest = digestOf({
    lineage: request.lineageId,
    version,
    task: request.taskId,
    purpose: request.purpose,
    maximumMinor: request.maximumMinor,
    currency: request.currency,
    payload: request.payload,
    step: request.step,
  });

  const versionId = randomUUID();
  await tx.query(
    `insert into public.proposal_versions
       (business_id, id, lineage_id, version, payload, payload_digest, purpose,
        maximum_minor, currency, proposed_by_actor_id)
     values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, $9, $10)`,
    [
      tx.businessId,
      versionId,
      request.lineageId,
      version,
      JSON.stringify(request.payload),
      payloadDigest,
      request.purpose,
      request.maximumMinor,
      request.currency,
      request.proposedByActorId,
    ],
  );

  const runId = randomUUID();
  await tx.query(
    `insert into public.planned_runs (business_id, id, lineage_id, version_id, task_id)
     values ($1, $2, $3, $4, $5)`,
    [tx.businessId, runId, request.lineageId, versionId, request.taskId],
  );

  const stepId = randomUUID();
  await tx.query(
    `insert into public.planned_steps (business_id, id, run_id, ordinal, kind, payload)
     values ($1, $2, $3, 1, $4, $5::text::jsonb)`,
    [tx.businessId, stepId, runId, request.step.kind, JSON.stringify(request.step.payload)],
  );

  // Rendered here, from the rows just written, before the gate exists (G07).
  const pack = await renderEvidence(tx, { versionId, runId });
  if (!pack.ok) return pack;

  const gateId = randomUUID();
  await tx.query(
    `insert into public.gates
       (business_id, id, lineage_id, version_id, run_id, step_id, evidence_pack_id,
        payload_digest, round, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tx.businessId,
      gateId,
      request.lineageId,
      versionId,
      runId,
      stepId,
      pack.value.evidencePackId,
      payloadDigest,
      round,
      request.expiresAt,
    ],
  );

  return {
    ok: true,
    value: {
      versionId,
      version,
      runId,
      stepId,
      evidencePackId: pack.value.evidencePackId,
      gateId,
      payloadDigest,
      supersededVersionId: previous?.id ?? null,
    },
  };
}

/** Formal rounds used so far in this lineage. Comments and steering are not rounds (G08). */
export async function roundsUsed(tx: TenantQuery, lineageId: string): Promise<number> {
  const rows = await tx.query<{ readonly rounds: string }>(
    `select count(*)::text as rounds from public.gate_decisions
      where business_id = $1 and lineage_id = $2 and decision = 'request_changes'`,
    [tx.businessId, lineageId],
  );
  return Number(rows[0]?.rounds ?? 0) + 1;
}
