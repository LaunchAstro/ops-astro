// SPDX-License-Identifier: AGPL-3.0-only
//
// The effect register's lookup, as a type alone: a leaf, so the broker's held
// calls (broker-effect.ts) and the reconciler (reconcile.ts) both name it
// without one importing the other.

import type { TenantQuery } from '../../../core-records/src/index.ts';

/** The register's answer for one unknown step: true, false, or `undefined` when it cannot answer. */
export type EffectLookup = (
  tx: TenantQuery,
  step: { readonly attemptId: string; readonly holderActorId: string; readonly stepKind: string },
) => Promise<boolean | undefined>;
