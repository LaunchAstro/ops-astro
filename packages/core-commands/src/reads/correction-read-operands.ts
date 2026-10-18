// SPDX-License-Identifier: AGPL-3.0-only
//
// The live correction reads' operands and answers (C80, #1694), on their own as
// `history-operands.ts` is, so the read requests take them without importing
// the reads' module.

import type {
  LiveCorrectionReadResult,
  LiveCorrectionReads,
} from '../../../core-wire/src/index.ts';

/** One correction's decision, read again for its card; the list; one correction's receipts. */
export interface CorrectionReadOperands {
  readonly 'live_correction.read': { readonly correctionId: string };
  readonly 'live_correction.list': Readonly<Record<never, never>>;
  readonly 'live_correction.receipts': { readonly correctionId: string };
}

/** What the live correction reads answer. */
export type CorrectionReadResult = LiveCorrectionReadResult | LiveCorrectionReads;
