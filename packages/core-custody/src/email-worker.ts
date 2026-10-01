// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery worker (stub: the pass is written next).

import type { BusinessId, Database } from '../../core-records/src/index.ts';
import type { EmailTiming } from './email-timing.ts';

export type DeliveryPass =
  | { readonly ok: true; readonly emails: number }
  | { readonly ok: false; readonly code: 'WORKER_REQUIRED' };

export async function deliverDue(
  _database: Database,
  _businessId: BusinessId,
  _workerActorId: string,
  _timing: EmailTiming,
  _kind: 'at_once' | 'daily',
): Promise<DeliveryPass> {
  return await Promise.resolve({ ok: true, emails: 0 });
}
