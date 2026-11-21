// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the installation's own records (the gate items, the installation mode and, C35 #2018,
// the capture pool reviews), spread into `handlers.ts`'s table, which is at its line cap.

import type { Handler } from './handler-types.ts';
import { changeInstallationMode, recordGateItem } from './gate-write.ts';
import { recordCapturePoolReview } from './pool-review-write.ts';

type OperationsWrite =
  | 'operations.record_gate_item'
  | 'operations.change_installation_mode'
  | 'operations.record_capture_pool_review';

export const OPERATIONS_HANDLERS: { readonly [K in OperationsWrite]: Handler<K> } = {
  'operations.record_gate_item': recordGateItem,
  'operations.change_installation_mode': changeInstallationMode,
  'operations.record_capture_pool_review': recordCapturePoolReview,
};
