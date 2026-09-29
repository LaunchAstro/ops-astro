// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.receipt` (T2c2): what an observed effect came from, asked on its
// attempt. The grant is asked on the task the attempt worked, resolved before
// the check, so a person outside that task's client is refused on the record
// and an outsider is told `NOT_FOUND`. Another business's attempt resolves to
// no task here and reads exactly as a made-up one. An attempt with no
// observed effect has no receipt. The receipt is the runtime's derived view
// (`core-runtime/src/receipt.ts`) and names no operation to undo it.

import { isUuid } from '../../../core-records/src/index.ts';
import { readReceipt, receiptTask } from '../../../core-runtime/src/index.ts';
import { effectOperationId } from '../../../core-wire/src/index.ts';
import { refuseNotFound } from '../commands/refusal.ts';
import { invalid } from '../commands/operands.ts';
import type { SpineRow } from './catalogue.ts';

export const RECEIPT_READ: SpineRow<'task.receipt'> = {
  identifiers: ['attemptId'],
  parse: ({ attemptId }) =>
    typeof attemptId === 'string'
      ? { ok: true, operands: { attemptId } }
      : { ok: false, refusal: invalid('attemptId', 'Send attemptId as the observed attempt.') },
  spine: true,
  subject: async (tx, _spine, { attemptId }) =>
    isUuid(attemptId) ? await receiptTask(tx, attemptId) : undefined,
  authority: 'declared',
  outsiderNotFound: true,
  async serve(tx, _session, { attemptId }, { recordId }) {
    if (recordId === undefined) return refuseNotFound();
    const receipt = await readReceipt(tx, attemptId, effectOperationId(attemptId));
    return receipt === undefined ? refuseNotFound() : { ok: true, receipt };
  },
};
