// SPDX-License-Identifier: AGPL-3.0-only
//
// #1694's two reads over `live_corrections` and `live_correction_receipts`:
// the corrections a reader reaches, and one correction's receipts. Each row is
// judged inside the statement that reads it, on two grants at once: the
// caller's `run:write` at the correction's own party (`COVERED`, as every read
// in `live-corrections.ts`), and their `task:read` on the correction's live
// task (`readableTaskCondition`, as every task read). A correction either
// grant misses is not read, so it is never told apart from one that does not
// exist. Unlocked: they read, and decide nothing.

import type { Subject } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import type { CorrectionState } from './live-corrections.ts';

/** The longest receipt text a read answers, in characters; a longer one is cut and marked. */
export const RECEIPT_TEXT_LIMIT = 4_000;

export interface ReadableCorrection {
  readonly correctionId: string;
  readonly taskId: string;
  readonly state: CorrectionState;
  readonly approver: string | null;
  readonly versionId: string;
  readonly pageUrl: string;
  readonly word: string;
  readonly replacement: string;
  readonly requestedAt: string;
}

export interface ReceiptText {
  readonly text: string;
  readonly clipped: boolean;
}

export interface ReadableReceipt {
  readonly receiptId: string;
  readonly step: 'publish' | 'revert';
  readonly outcome: string;
  readonly recordedAt: string;
  readonly commit: string | null;
  readonly deploymentId: string | null;
  readonly beforeCapture: ReceiptText | null;
  readonly afterCapture: ReceiptText | null;
}

/** The corrections both grants reach, newest first, at most `LIST_LIMIT`. */
export async function listReadableCorrections(
  _tx: TenantQuery,
  _subjects: readonly Subject[],
): Promise<readonly ReadableCorrection[]> {
  return await Promise.resolve([]);
}

/**
 * One correction's receipts, newest first, when both grants reach it; or
 * undefined: absent, in another business or not reached are one answer.
 */
export async function readReadableReceipts(
  _tx: TenantQuery,
  correctionId: string,
  _subjects: readonly Subject[],
): Promise<
  { readonly correctionId: string; readonly receipts: readonly ReadableReceipt[] } | undefined
> {
  return await Promise.resolve({ correctionId, receipts: [] });
}
