// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the installation's own records' data effects, spread into `COMMAND_EFFECTS`, which is
// at its line cap. No client's rows, so no client-scoped write.

import { business, writing, type DataEffects } from './data-effects-types.ts';

type OperationsWrite =
  | 'operations.record_gate_item'
  | 'operations.change_installation_mode'
  | 'operations.record_capture_pool_review';

export const OPERATIONS_EFFECTS: { readonly [Name in OperationsWrite]: DataEffects } = {
  'operations.record_gate_item': writing(business('ops.gate_items')),
  'operations.change_installation_mode': writing(business('ops.installation')),
  // C35 (#2018): a closed capture pool review, installation-wide.
  'operations.record_capture_pool_review': writing(business('ops.capture_pool_reviews')),
};
