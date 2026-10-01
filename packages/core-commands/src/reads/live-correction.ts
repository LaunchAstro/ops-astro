// SPDX-License-Identifier: AGPL-3.0-only
//
// `live_correction.read` (C80): one correction's decision, for its card. It
// answers the state as the request and decide commands name it, the person
// who decided it by name (null until then) and the version, and nothing the
// card already holds: no word, path, page or line comes back.
//
// The grant is `run:write`, the request's own key (ORCH33: the only key on
// `run`), asked at the correction's party inside the query
// (`readCoveredDecision`), so a party grant on one client's site reads no other
// client's correction. A caller holding `run:write` nowhere is refused
// `SCOPE_NOT_GRANTED` before any id is looked at; for everyone else, not
// there, in another business, out of reach, a client's or malformed is one
// `NOT_FOUND`, so the read confirms no id. It is the team's, as
// `task.execution` is, and never an agent's (`agent: 'never'`, `surface.ts`).

import {
  holdsAnywhere,
  isUuid,
  readCoveredDecision,
  RUN_COLLECTION,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { LiveCorrectionReadResult } from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { invalid } from '../commands/operands.ts';
import { isInternalReader } from './tasks.ts';

type Operands = { readonly correctionId: string };

const NO_RUN_WRITE = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);

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

export async function serveCorrectionRead(
  tx: TenantQuery,
  session: Session,
  { correctionId }: Operands,
): Promise<LiveCorrectionReadResult | CommandRefusal> {
  const covering = { subjects: subjectsOf(session), collection: RUN_COLLECTION, action: 'write' };
  if (!(await holdsAnywhere(tx, covering))) return NO_RUN_WRITE;
  if (!isInternalReader(session.roleKey) || !isUuid(correctionId)) return refuseNotFound();
  const correction = await readCoveredDecision(tx, correctionId, covering);
  return correction === undefined ? refuseNotFound() : { ok: true, correction };
}
