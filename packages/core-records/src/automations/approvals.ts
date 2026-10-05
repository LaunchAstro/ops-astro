// SPDX-License-Identifier: AGPL-3.0-only
//
// Standing approvals (C52-A; migration 20261005060312). An adoption pins an
// exact released version on an activation and is the standing approval for
// every later occurrence on that pin (C27-1, C27-2); a rollback adopts again
// a version the activation adopted before. A revocation is written beside the
// approval, which stays in history. Every change here locks the activation
// first, so a claim, a dispatch and a person's change to the same activation
// take turns, and each compares the revision the caller read under that lock.
//
// Dispatch, the worker's step after the claim, is in `dispatch.ts`.
//
// Red: the records API is declared and throws until it is built.

import type { TenantQuery } from '../tenancy/database.ts';
import type { ActivationRow, DefinitionVersionRow } from './automations.ts';

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

const notBuilt = (): never => {
  throw new Error('C52-A: not built');
};

export async function adoptVersion(_tx: TenantQuery, _adoption: Adoption): Promise<AdoptionResult> {
  return await Promise.resolve(notBuilt());
}

export async function rollbackTarget(
  _tx: TenantQuery,
  _activationId: string,
): Promise<DefinitionVersionRow | null> {
  return await Promise.resolve(notBuilt());
}

export async function readStandingApproval(
  _tx: TenantQuery,
  _activationId: string,
): Promise<StandingApprovalRow | null> {
  return await Promise.resolve(notBuilt());
}

export async function listApprovals(
  _tx: TenantQuery,
  _activationId: string,
): Promise<readonly StandingApprovalRow[]> {
  return await Promise.resolve(notBuilt());
}

export async function revokeApproval(
  _tx: TenantQuery,
  _revocation: { readonly approvalId: string; readonly actorId: string },
): Promise<RevokeResult> {
  return await Promise.resolve(notBuilt());
}

export async function turnOffActivation(
  _tx: TenantQuery,
  _change: {
    readonly activationId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
  },
): Promise<TurnOffResult> {
  return await Promise.resolve(notBuilt());
}
