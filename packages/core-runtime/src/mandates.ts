// SPDX-License-Identifier: AGPL-3.0-only
//
// Core's standing mandate check (MP-14-10a): not built yet. Every question is
// left to the ordinary gate, so nothing is pre-approved.

import type { TenantQuery } from '../../core-records/src/index.ts';

export interface MandateQuestion {
  readonly clientId: string;
  readonly actionClass: string;
  readonly valueMinor: number;
  readonly currency: string;
}

export type MandateVerdict =
  | { readonly covered: true; readonly mandateId: string }
  | {
      readonly covered: false;
      readonly reason: 'refused' | 'over-ceiling' | 'expired';
      readonly mandateId: string;
    }
  | { readonly covered: false; readonly reason: 'none' };

export async function standingMandateVerdict(
  _tx: TenantQuery,
  _question: MandateQuestion,
): Promise<MandateVerdict> {
  return await Promise.resolve({ covered: false, reason: 'none' });
}
