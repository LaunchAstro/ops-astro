// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing approvals (C52-A; migration 20261005193201). An adoption pins an
// exact released version on an activation and is the standing approval for
// every later occurrence on that pin (C27-1, C27-2); a rollback adopts again
// a version the activation adopted before. A revocation is written beside the
// approval, which stays in history. Every change here locks the activation
// first, so a claim, a dispatch and a person's change to the same activation
// take turns, and each compares the revision the caller read under that lock.
//
// Dispatch, the worker's step after the claim, is in `dispatch.ts`.

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

/**
 * The activation, locked for this transaction's change, or null. A
 * transaction locks one activation: each writer takes its row, then
 * business-wide locks held to commit (C33's rates, intake and run ceiling),
 * so a second activation's row after them could close a cycle with that
 * activation's own writer. Any other is refused before its row is touched.
 */
export async function lockActivation(
  tx: TenantQuery,
  activationId: string,
): Promise<ActivationRow | null> {
  const one = await tx.query<{ readonly id: string }>(
    `select set_config('ops_astro.activation', $1::uuid::text, true) as id
      where coalesce(current_setting('ops_astro.activation', true), '') in ('', $1::uuid::text)`,
    [activationId],
  );
  if (one[0] === undefined) throw new Error('one transaction locks one activation');
  const rows = await tx.query<ActivationDbRow>(
    `select ${ACTIVATION_COLUMNS} from public.activations
      where business_id = $1 and id = $2 for update`,
    [tx.businessId, activationId],
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
  if (updated[0] === undefined) {
    throw new Error('adoptVersion: the locked activation was not updated');
  }
  return {
    kind: 'adopted',
    approval: await readApproval(tx, approvalId),
    activation: activationOf(updated[0]),
  };
}

/**
 * The version a rollback returns to: the highest-numbered version below the
 * pin that this activation adopted before under an approval nobody revoked,
 * or null. A version the activation never adopted, or one whose every
 * adoption was revoked, is never approved by a rollback.
 */
export async function rollbackTarget(
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
        and exists (select 1 from public.standing_approvals s
                     where s.activation_id = a.id and s.version_id = v.id
                       and not exists (select 1 from public.standing_approval_revocations r
                                        where r.approval_id = s.id))
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
       join public.standing_approvals s on s.business_id = a.business_id and s.id = a.approval_id
      where a.business_id = $1 and a.id = $2`,
    [tx.businessId, activationId],
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
  return rows.map((row) => approvalOf(row));
}

/** The activation an approval belongs to, or null for an approval this business has not got. */
export async function approvalActivation(
  tx: TenantQuery,
  approvalId: string,
): Promise<string | null> {
  const found = await tx.query<{ readonly activation_id: string }>(
    'select activation_id from public.standing_approvals where id = $1',
    [approvalId],
  );
  return found[0]?.activation_id ?? null;
}

/**
 * Revokes an approval once. The activation it belongs to is locked first, so
 * a dispatch in flight finishes before the revoke and the next one sees it.
 */
export async function revokeApproval(
  tx: TenantQuery,
  revocation: { readonly approvalId: string; readonly actorId: string },
): Promise<RevokeResult> {
  const activationId = await approvalActivation(tx, revocation.approvalId);
  if (activationId === null) return 'unknown';
  await lockActivation(tx, activationId);
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
