// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing approvals (C52-A, U36; migration 0037). An adoption pins an exact
// released version on an activation and is the standing approval for every
// later occurrence on that pin (C27-1, C27-2); a rollback is an adoption of
// the version before. A revocation is written beside the approval, which stays
// in history. Every change here locks the activation first, so a claim, a
// dispatch and a person's change to the same activation take turns.
//
// Dispatch is the worker's step after the claim (AW-01's lease, not on this
// branch): it rechecks, under that lock, that the activation is on and the
// approval the occurrence recorded is still the one standing and unrevoked,
// and writes the result once. Only then is the run asked for, through the
// agent engine's starter.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  ACTIVATION_COLUMNS,
  activationOf,
  readVersion,
  type ActivationDbRow,
  type ActivationRow,
  type DefinitionVersionRow,
} from './automations.ts';
import type { OccurrenceOutcome } from './occurrences.ts';

export type AdoptionAct = 'adopted' | 'rolled_back';

export interface StandingApprovalRow {
  readonly id: string;
  readonly activationId: string;
  readonly versionId: string;
  readonly previousVersionId: string;
  readonly act: AdoptionAct;
  readonly sequence: number;
  readonly decidedByActorId: string;
  readonly revoked: boolean;
}

export interface Adoption {
  readonly activationId: string;
  readonly versionId: string;
  readonly expectedRevision: number;
  readonly act: AdoptionAct;
  readonly actorId: string;
}

export type AdoptionResult =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'stale'; readonly revision: number }
  | {
      readonly kind: 'adopted';
      readonly approval: StandingApprovalRow;
      readonly activation: ActivationRow;
    };

export type TurnOffResult =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'stale'; readonly revision: number }
  | { readonly kind: 'off' | 'already_off'; readonly activation: ActivationRow };

export type RevokeResult = 'unknown' | 'revoked' | 'already_revoked';

export type DispatchOutcome = 'started' | 'activation_off' | 'approval_revoked' | 'approval_ended';

export interface DispatchRow {
  readonly occurrenceId: string;
  readonly outcome: DispatchOutcome;
  readonly runId: string | null;
}

export interface RunRequest {
  readonly occurrenceId: string;
  readonly activationId: string;
  readonly versionId: string;
}

export type RunStarter = (tx: TenantQuery, run: RunRequest) => Promise<string>;

export type Dispatch =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'not_approved'; readonly outcome: OccurrenceOutcome }
  | { readonly kind: 'dispatched' | 'replayed'; readonly dispatch: DispatchRow };

interface ApprovalDbRow {
  readonly id: string;
  readonly activation_id: string;
  readonly version_id: string;
  readonly previous_version_id: string;
  readonly act: AdoptionAct;
  readonly sequence: string;
  readonly decided_by_actor_id: string;
  readonly revoked: boolean;
}

const APPROVAL_COLUMNS = `s.id, s.activation_id, s.version_id, s.previous_version_id, s.act, s.sequence,
  s.decided_by_actor_id,
  exists (select 1 from public.standing_approval_revocations r where r.approval_id = s.id) as revoked`;

const approvalOf = (row: ApprovalDbRow): StandingApprovalRow => ({
  id: row.id,
  activationId: row.activation_id,
  versionId: row.version_id,
  previousVersionId: row.previous_version_id,
  act: row.act,
  sequence: Number(row.sequence),
  decidedByActorId: row.decided_by_actor_id,
  revoked: row.revoked,
});

/** The activation, locked for this transaction's change, or null. */
async function lockActivation(
  tx: TenantQuery,
  activationId: string,
): Promise<ActivationRow | null> {
  const rows = await tx.query<ActivationDbRow>(
    `select ${ACTIVATION_COLUMNS} from public.activations where id = $1 for update`,
    [activationId],
  );
  return rows[0] === undefined ? null : activationOf(rows[0]);
}

async function readApproval(tx: TenantQuery, approvalId: string): Promise<StandingApprovalRow> {
  const rows = await tx.query<ApprovalDbRow>(
    `select ${APPROVAL_COLUMNS} from public.standing_approvals s where s.id = $1`,
    [approvalId],
  );
  if (rows[0] === undefined) throw new Error('standing approval: the written row is not visible');
  return approvalOf(rows[0]);
}

/**
 * Pins the version and approves it, at the revision the caller read. A version
 * of another definition answers `unknown`, as another business's would; the
 * command refuses it, and a mode the version does not permit, before this.
 */
export async function adoptVersion(tx: TenantQuery, adoption: Adoption): Promise<AdoptionResult> {
  const current = await lockActivation(tx, adoption.activationId);
  if (current === null) return { kind: 'unknown' };
  if (current.revision !== adoption.expectedRevision) {
    return { kind: 'stale', revision: current.revision };
  }
  const own = await tx.query(
    'select 1 from public.definition_versions where id = $1 and definition_id = $2',
    [adoption.versionId, current.definitionId],
  );
  if (own.length === 0) return { kind: 'unknown' };
  const approvalId = randomUUID();
  const revision = current.revision + 1;
  await tx.query(
    `insert into public.standing_approvals
       (business_id, id, activation_id, definition_id, version_id, previous_version_id, act, sequence,
        decided_by_actor_id)
     values ((select public.app_business_id()), $1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      approvalId,
      current.id,
      current.definitionId,
      adoption.versionId,
      current.versionId,
      adoption.act,
      revision,
      adoption.actorId,
    ],
  );
  const updated = await tx.query<ActivationDbRow>(
    `update public.activations
        set version_id = $2, approval_id = $3, revision = $4, changed_by_actor_id = $5, changed_at = now()
      where id = $1
      returning ${ACTIVATION_COLUMNS}`,
    [current.id, adoption.versionId, approvalId, revision, adoption.actorId],
  );
  if (updated[0] === undefined)
    throw new Error('adoptVersion: the locked activation was not updated');
  return {
    kind: 'adopted',
    approval: await readApproval(tx, approvalId),
    activation: activationOf(updated[0]),
  };
}

/** The released version numbered just below the activation's pin, or null. */
export async function previousVersion(
  tx: TenantQuery,
  activationId: string,
): Promise<DefinitionVersionRow | null> {
  const rows = await tx.query<{ readonly id: string }>(
    `select v.id
       from public.activations a
       join public.definition_versions pinned on pinned.id = a.version_id
       join public.definition_versions v
         on v.definition_id = a.definition_id and v.number < pinned.number
      where a.id = $1
      order by v.number desc
      limit 1`,
    [activationId],
  );
  return rows[0] === undefined ? null : await readVersion(tx, rows[0].id);
}

/** The approval the activation names, revoked or not, or null when none stands. */
export async function readStandingApproval(
  tx: TenantQuery,
  activationId: string,
): Promise<StandingApprovalRow | null> {
  const rows = await tx.query<ApprovalDbRow>(
    `select ${APPROVAL_COLUMNS}
       from public.activations a
       join public.standing_approvals s on s.id = a.approval_id
      where a.id = $1`,
    [activationId],
  );
  return rows[0] === undefined ? null : approvalOf(rows[0]);
}

/** Every adoption of the activation, oldest first. */
export async function listApprovals(
  tx: TenantQuery,
  activationId: string,
): Promise<readonly StandingApprovalRow[]> {
  const rows = await tx.query<ApprovalDbRow>(
    `select ${APPROVAL_COLUMNS} from public.standing_approvals s
      where s.activation_id = $1 order by s.sequence`,
    [activationId],
  );
  return rows.map(approvalOf);
}

export async function revokeApproval(
  tx: TenantQuery,
  revocation: { readonly approvalId: string; readonly actorId: string },
): Promise<RevokeResult> {
  const found = await tx.query<{ readonly activation_id: string }>(
    'select activation_id from public.standing_approvals where id = $1',
    [revocation.approvalId],
  );
  if (found[0] === undefined) return 'unknown';
  // A claim or dispatch in flight finishes first; the next one sees the revoke.
  await lockActivation(tx, found[0].activation_id);
  const written = await tx.query(
    `insert into public.standing_approval_revocations (business_id, id, approval_id, revoked_by_actor_id)
     values ((select public.app_business_id()), $1, $2, $3)
     on conflict do nothing
     returning approval_id`,
    [randomUUID(), revocation.approvalId, revocation.actorId],
  );
  return written.length === 1 ? 'revoked' : 'already_revoked';
}

/** Switches the activation off at the revision the caller read; its approval ends with it. */
export async function turnOffActivation(
  tx: TenantQuery,
  change: {
    readonly activationId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
  },
): Promise<TurnOffResult> {
  const current = await lockActivation(tx, change.activationId);
  if (current === null) return { kind: 'unknown' };
  if (current.revision !== change.expectedRevision) {
    return { kind: 'stale', revision: current.revision };
  }
  if (!current.enabled) return { kind: 'already_off', activation: current };
  const updated = await tx.query<ActivationDbRow>(
    `update public.activations
        set enabled = false, revision = revision + 1, changed_by_actor_id = $2, changed_at = now()
      where id = $1
      returning ${ACTIVATION_COLUMNS}`,
    [current.id, change.actorId],
  );
  if (updated[0] === undefined) {
    throw new Error('turnOffActivation: the locked activation was not updated');
  }
  return { kind: 'off', activation: activationOf(updated[0]) };
}

interface ClaimedDbRow {
  readonly activation_id: string;
  readonly version_id: string;
  readonly outcome: OccurrenceOutcome;
  readonly approval_id: string | null;
}

interface DispatchDbRow {
  readonly occurrence_id: string;
  readonly outcome: DispatchOutcome;
  readonly run_id: string | null;
}

const dispatchOf = (row: DispatchDbRow): DispatchRow => ({
  occurrenceId: row.occurrence_id,
  outcome: row.outcome,
  runId: row.run_id,
});

function dispatchOutcome(
  activation: ActivationRow | null,
  standing: StandingApprovalRow | null,
  recorded: string,
): DispatchOutcome {
  if (activation === null || !activation.enabled) return 'activation_off';
  if (standing?.id !== recorded) return 'approval_ended';
  return standing.revoked ? 'approval_revoked' : 'started';
}

/**
 * Dispatches an approved occurrence once. Under the activation's lock it
 * rechecks the switch and the approval, so an occurrence claimed before a
 * revoke or a turn-off starts nothing after it; a second dispatch of the same
 * occurrence waits for the first and answers `replayed` with its result.
 */
export async function dispatchOccurrence(
  tx: TenantQuery,
  occurrenceId: string,
  startRun: RunStarter,
): Promise<Dispatch> {
  const claimed = await tx.query<ClaimedDbRow>(
    `select activation_id, version_id, outcome, approval_id
       from public.activation_occurrences where id = $1`,
    [occurrenceId],
  );
  const occurrence = claimed[0];
  if (occurrence === undefined) return { kind: 'unknown' };
  if (occurrence.outcome !== 'approved' || occurrence.approval_id === null) {
    return { kind: 'not_approved', outcome: occurrence.outcome };
  }
  const activation = await lockActivation(tx, occurrence.activation_id);
  const earlier = await tx.query<DispatchDbRow>(
    'select occurrence_id, outcome, run_id from public.occurrence_dispatches where occurrence_id = $1',
    [occurrenceId],
  );
  if (earlier[0] !== undefined) return { kind: 'replayed', dispatch: dispatchOf(earlier[0]) };
  const standing = await readStandingApproval(tx, occurrence.activation_id);
  const outcome = dispatchOutcome(activation, standing, occurrence.approval_id);
  const runId =
    outcome === 'started'
      ? await startRun(tx, {
          occurrenceId,
          activationId: occurrence.activation_id,
          versionId: occurrence.version_id,
        })
      : null;
  const written = await tx.query<DispatchDbRow>(
    `insert into public.occurrence_dispatches (business_id, id, occurrence_id, outcome, run_id)
     values ((select public.app_business_id()), $1, $2, $3, $4)
     returning occurrence_id, outcome, run_id`,
    [randomUUID(), occurrenceId, outcome, runId],
  );
  if (written[0] === undefined) throw new Error('dispatchOccurrence: the dispatch was not written');
  return { kind: 'dispatched', dispatch: dispatchOf(written[0]) };
}
