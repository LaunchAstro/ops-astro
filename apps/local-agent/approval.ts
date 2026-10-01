// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1's approval gate (#859): not built yet; the tests name what it must do.

import type {
  BusinessId,
  Database,
  VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import type { Environment, Refused } from './tick.ts';

export const APPROVAL_PURPOSE = 'local_agent_approval';

export type Need =
  | { readonly kind: 'cap'; readonly capUsd: number }
  | { readonly kind: 'model'; readonly model: string };

export type NeedCode = 'LOCAL_CAP_REACHED' | 'LOCAL_MODEL_NOT_APPROVED';

export interface ApprovalOptions {
  readonly environment: Environment;
  readonly database: Database;
  readonly businessId: BusinessId;
  readonly agent: VerifiedSubject;
  readonly home: string;
  readonly currency?: string;
}

export interface HeldLease {
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

export function needOf(_code: NeedCode, _model: string): Need {
  throw new Error('not built');
}

export async function raiseApproval(
  _options: ApprovalOptions,
  _lease: HeldLease,
  _need: Need,
): Promise<{ readonly ok: true; readonly raised: boolean } | Refused> {
  throw new Error('not built');
}

export async function applyApprovals(
  _options: ApprovalOptions,
): Promise<{ readonly ok: true; readonly applied: readonly Need[] } | Refused> {
  throw new Error('not built');
}
