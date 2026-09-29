// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c1, the dispatch transaction. Red-first stub: the shapes only.

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { RuntimeResult } from './refusals.ts';

export const EFFECT_TIME_FACTS = [] as const;
export type ReconcileMode = 'replay' | 'observe' | 'neither';
export const EFFECT_OPERATIONS: Readonly<Record<string, ReconcileMode>> = {};

export type DispatchRequest =
  | {
      readonly claimant: 'agent';
      readonly leaseId: string;
      readonly fence: number;
      readonly holderActorId: string;
      readonly delegationId: string;
    }
  | {
      readonly claimant: 'person';
      readonly leaseId: string;
      readonly fence: number;
      readonly holderActorId: string;
      readonly subjects: readonly { readonly kind: 'person' | 'actor'; readonly id: string }[];
      readonly collection: string;
    };

export interface Dispatched {
  readonly leaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly stepId: string;
  readonly stepKind: string;
  readonly reconcileMode: ReconcileMode;
  readonly dispatchedAt: Date;
}

export async function dispatch(
  _tx: TenantQuery,
  _request: DispatchRequest,
): Promise<RuntimeResult<Dispatched>> {
  throw new Error('T2c1: dispatch is not built yet');
}
