// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d1: the reconciliation phase of the one pass T3b built. Red first: the
// stub answers nothing.

import type { TenantQuery } from '../../../core-records/src/index.ts';

/** The register's answer for one unknown step: true, false, or `undefined` when it cannot answer. */
export type EffectLookup = (
  tx: TenantQuery,
  step: { readonly attemptId: string; readonly holderActorId: string; readonly stepKind: string },
) => Promise<boolean | undefined>;

export interface Reconciled {
  readonly attemptId: string;
  readonly answer: 'present' | 'absent' | 'unanswered';
  readonly reason: string;
}

export async function reconcileUnknown(
  _tx: TenantQuery,
  _lookup: EffectLookup,
): Promise<readonly Reconciled[]> {
  return await Promise.reject(new Error('T3d1: reconcileUnknown is not built yet'));
}
