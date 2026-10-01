// SPDX-License-Identifier: AGPL-3.0-only
//
// `live_correction.read` (C80): one correction's decision, for its card.

import type { Delegation, Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { LiveCorrectionReadResult } from '../../../core-wire/src/index.ts';
import { refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { invalid } from '../commands/operands.ts';
import { refused, type HandlerOutcome } from '../commands/outcome.ts';

type Operands = { readonly correctionId: string };

export function parseCorrectionRead(
  body: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly operands: Operands }
  | { readonly ok: false; readonly refusal: CommandRefusal } {
  const { correctionId } = body;
  return typeof correctionId === 'string'
    ? { ok: true, operands: { correctionId } }
    : { ok: false, refusal: invalid('correctionId', 'Send correctionId as the correction.') };
}

export function serveCorrectionRead(
  _tx: TenantQuery,
  _session: Session,
  _operands: Operands,
): Promise<LiveCorrectionReadResult | CommandRefusal> {
  return Promise.resolve(refuseNotFound());
}

export function readCorrectionAsAgent(
  _tx: TenantQuery,
  _operands: Operands,
  _delegation: Delegation,
): Promise<HandlerOutcome> {
  return Promise.resolve(refused(refuseNotFound()));
}
