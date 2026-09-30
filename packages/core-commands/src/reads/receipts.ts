// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.receipt` (T2c2): what an observed effect came from, asked on its
// attempt. The grant is asked on the task the attempt worked, resolved before
// the check, so a person outside that task's client is refused on the record
// and an outsider is told `NOT_FOUND`. Another business's attempt resolves to
// no task here and reads exactly as a made-up one. A reader outside the team,
// the task's own client included, is shown the shared view of a task, which
// carries no proposal or decision, so it is told `NOT_FOUND` here too. An
// attempt with no observed effect has no receipt. The receipt is the runtime's derived view
// (`core-runtime/src/receipt.ts`) and names no operation to undo it.

import { isUuid, type Session, type TenantQuery } from '../../../core-records/src/index.ts';
import { readReceipt, receiptTask, type Receipt } from '../../../core-runtime/src/index.ts';
import { effectOperationId } from '../../../core-wire/src/index.ts';
import { refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { invalid } from '../commands/operands.ts';
import { isInternalReader } from './tasks.ts';

type Operands = { readonly attemptId: string };

export function parseReceipt(
  body: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly operands: Operands }
  | { readonly ok: false; readonly refusal: CommandRefusal } {
  const { attemptId } = body;
  return typeof attemptId === 'string'
    ? { ok: true, operands: { attemptId } }
    : {
        ok: false,
        refusal: invalid('attemptId', 'Send attemptId as the observed attempt.'),
      };
}

/** The attempt's task, before the grant check; a malformed id names none. */
export async function receiptSubject(
  tx: TenantQuery,
  _spine: unknown,
  { attemptId }: Operands,
): Promise<string | undefined> {
  return isUuid(attemptId) ? await receiptTask(tx, attemptId) : undefined;
}

export async function serveReceipt(
  tx: TenantQuery,
  session: Session,
  { attemptId }: Operands,
  { recordId }: { readonly recordId: string | undefined },
): Promise<{ readonly ok: true; readonly receipt: Receipt } | CommandRefusal> {
  if (recordId === undefined || !isInternalReader(session.roleKey)) return refuseNotFound();
  const receipt = await readReceipt(tx, attemptId, effectOperationId(attemptId));
  return receipt === undefined ? refuseNotFound() : { ok: true, receipt };
}
