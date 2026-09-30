// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11: a helper's work, from its one-call pickup to the parent's merged
// result. Not built yet.

import type {
  ChildMintRequest,
  CommandRefusal,
  Delegation,
  PurposeScope,
  RefusalCode,
  TenantQuery,
} from '../../core-records/src/index.ts';
import type { FileIdentity } from './definitions.ts';

export type ChildWorkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CommandRefusal };

export interface DelegateChildRequest {
  readonly leaseId: string;
  readonly fence: number;
  readonly child: ChildMintRequest;
}

export interface ChildPickup {
  readonly businessId: string;
  readonly childDelegationId: string;
  readonly credential: string;
  readonly resource: {
    readonly taskId: string;
    readonly runId: string;
    readonly leaseId: string;
    readonly fence: number;
    readonly reservationId: string;
  };
  readonly approvedVersion: { readonly versionId: string; readonly taskRevision: number };
  readonly permittedOperations: readonly string[];
  readonly envelope: {
    readonly envelopeId: string;
    readonly currency: string;
    readonly heldMinor: number;
  };
  readonly actorScope: {
    readonly agentActorId: string;
    readonly delegatePersonId: string;
    readonly purposeScope: PurposeScope;
    readonly expiresAt: Date;
  };
  readonly bootstrap: FileIdentity | null;
  readonly declaredIncompleteness: readonly string[];
}

export type ChildHandback =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'partial'; readonly refusal: RefusalCode };

export interface ChildResult {
  readonly childDelegationId: string;
  readonly helperActorId: string;
  readonly state: 'working' | 'handed_back' | 'dropped';
  readonly outcome: 'completed' | 'partial' | null;
  readonly refusal: string | null;
  readonly fault: 'DELEGATION_EXPIRED' | 'DELEGATION_REVOKED' | 'DELEGATION_NARROWED' | null;
}

export async function delegateChild(
  _tx: TenantQuery,
  _parent: Delegation,
  _request: DelegateChildRequest,
): Promise<ChildWorkResult<ChildPickup>> {
  return await Promise.reject(new Error('delegateChild: not built'));
}

export async function handBackChild(
  _tx: TenantQuery,
  _helper: { readonly agentActorId: string; readonly credential: string },
  _handback: ChildHandback,
): Promise<ChildWorkResult<{ readonly childDelegationId: string }>> {
  return await Promise.reject(new Error('handBackChild: not built'));
}

export async function childResults(
  _tx: TenantQuery,
  _parent: Delegation,
): Promise<readonly ChildResult[]> {
  return await Promise.reject(new Error('childResults: not built'));
}
