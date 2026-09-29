// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing approvals (C52-A, U36; migration 0037).

import type { TenantQuery } from '../tenancy/database.ts';
import type { ActivationRow, DefinitionVersionRow } from './automations.ts';
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
  | { readonly kind: 'off'; readonly activation: ActivationRow };

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

const NOT_BUILT = 'C52-A: not built';

export function adoptVersion(_tx: TenantQuery, _adoption: Adoption): Promise<AdoptionResult> {
  return Promise.reject(new Error(NOT_BUILT));
}

export function previousVersion(
  _tx: TenantQuery,
  _activationId: string,
): Promise<DefinitionVersionRow | null> {
  return Promise.reject(new Error(NOT_BUILT));
}

export function readStandingApproval(
  _tx: TenantQuery,
  _activationId: string,
): Promise<StandingApprovalRow | null> {
  return Promise.reject(new Error(NOT_BUILT));
}

export function listApprovals(
  _tx: TenantQuery,
  _activationId: string,
): Promise<readonly StandingApprovalRow[]> {
  return Promise.reject(new Error(NOT_BUILT));
}

export function revokeApproval(
  _tx: TenantQuery,
  _revocation: { readonly approvalId: string; readonly actorId: string },
): Promise<RevokeResult> {
  return Promise.reject(new Error(NOT_BUILT));
}

export function turnOffActivation(
  _tx: TenantQuery,
  _change: {
    readonly activationId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
  },
): Promise<TurnOffResult> {
  return Promise.reject(new Error(NOT_BUILT));
}

export function dispatchOccurrence(
  _tx: TenantQuery,
  _occurrenceId: string,
  _startRun: RunStarter,
): Promise<Dispatch> {
  return Promise.reject(new Error(NOT_BUILT));
}
