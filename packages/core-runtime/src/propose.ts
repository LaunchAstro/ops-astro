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
import { acquire } from './locks.ts';
import { digestOf } from './signing.ts';
import { renderEvidence } from './evidence.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

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

export async function propose(
  tx: TenantQuery,
  request: ProposeRequest,
): Promise<RuntimeResult<Proposal>> {
  // Authority first, and on both actions. `write` is "you may change this
  // task"; `comment` would not be enough to commit a business to work, and
  // `decide` is deliberately not asked for — proposing is not deciding.
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

  // The lineage and the task, in the contract's order: task before lineage.
  const lineageId = request.lineageId ?? null;
  await acquire(tx, [
    { lockClass: 'task', id: request.taskId },
    ...(lineageId === null ? [] : [{ lockClass: 'lineage' as const, id: lineageId }]),
  ]);

  let lineage: LineageRow;
  if (lineageId === null) {
    const opened = await tx.query<LineageRow>(
      `insert into public.proposal_lineages (business_id, id, task_id, opened_by_actor_id)
       values ($1, $2, $3, $4)
       returning id, state, task_id`,
      [tx.businessId, randomUUID(), request.taskId, request.proposedByActorId],
    );
    lineage = opened[0] as LineageRow;
  } else {
    const found = await tx.query<LineageRow>(
      `select id, state, task_id from public.proposal_lineages
        where business_id = $1 and id = $2`,
      [tx.businessId, lineageId],
    );
    const row = found[0];
    if (row === undefined) {
      return refuse(
        'GATE_NOT_FOUND',
        `no proposal lineage ${lineageId} in this business`,
        'Propose without a lineage to open a new one.',
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

  // Supersede the live version and, with it, the gate that was bound to it.
  // Doing this before the insert is what the one-live-version index requires,
  // and it is also G04: the earlier approval stays in the chain as history and
  // stops being able to authorise anything.
  const superseded = await tx.query<{ readonly id: string }>(
    `update public.proposal_versions set superseded_at = now()
      where business_id = $1 and lineage_id = $2 and superseded_at is null
      returning id`,
    [tx.businessId, lineage.id],
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
    round = carried === undefined ? await roundsUsed(tx, lineage.id) : Number(carried.used);
  }

  const versionNumbers = await tx.query<{ readonly next: string }>(
    `select coalesce(max(version), 0) + 1 as next from public.proposal_versions
      where business_id = $1 and lineage_id = $2`,
    [tx.businessId, lineage.id],
  );
  const version = Number(versionNumbers[0]?.next ?? 1);

  const payloadDigest = digestOf({
    lineage: lineage.id,
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
      lineage.id,
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
    [tx.businessId, runId, lineage.id, versionId, request.taskId],
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
      lineage.id,
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
      lineageId: lineage.id,
      versionId,
      version,
      runId,
      stepId,
      evidencePackId: pack.value.evidencePackId,
      gateId,
      payloadDigest,
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

/** Formal rounds used so far in this lineage. Comments and steering are not rounds (G08). */
export async function roundsUsed(tx: TenantQuery, lineageId: string): Promise<number> {
  const rows = await tx.query<{ readonly rounds: string }>(
    `select count(*)::text as rounds from public.gate_decisions
      where business_id = $1 and lineage_id = $2 and decision = 'request_changes'`,
    [tx.businessId, lineageId],
  );
  return Number(rows[0]?.rounds ?? 0) + 1;
}
