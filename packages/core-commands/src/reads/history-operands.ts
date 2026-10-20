// SPDX-License-Identifier: AGPL-3.0-only
//
// `automation.history`'s operands (#1741), on their own so the read's module
// and the read requests both import them without importing each other.

import type { ActivationHistoryCursor } from '../../../core-records/src/index.ts';

/** `automation.history`'s operands: the activation, and where the page starts. */
export interface HistoryOperands {
  readonly activationId: string;
  readonly cursor?: ActivationHistoryCursor;
}
