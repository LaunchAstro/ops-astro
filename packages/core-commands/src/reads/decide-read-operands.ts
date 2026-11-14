// SPDX-License-Identifier: AGPL-3.0-only
//
// The reads filtered by the caller's `decide` inside the query: the gates
// waiting on a decision (MP-6-1) and the deleted tasks (#2346). Their operands
// and answers, on their own as `correction-read-operands.ts` is, so the read
// requests take them without importing the reads' modules.

import type { AwaitingReviewResult, TaskBinResult } from '../../../core-wire/src/index.ts';

export interface DecideReads {
  /** The pending gates the caller may decide, filtered by their `decide` in the query. */
  readonly 'gate.pending': Readonly<Record<never, never>>;
  /** The deleted tasks the caller may restore, filtered by their `decide` in the query. */
  readonly 'task.bin': Readonly<Record<never, never>>;
}

/** What the two answer. */
export type DecideReadResult = AwaitingReviewResult | TaskBinResult;
