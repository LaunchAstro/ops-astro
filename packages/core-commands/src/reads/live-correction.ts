// SPDX-License-Identifier: AGPL-3.0-only
//
// The live correction's reads (C80, #1694), each a row of the read catalogue,
// moved here whole for its line cap.
//
// `live_correction.read`: one correction's decision, for its card. It answers
// the state as the request and decide commands name it, the person who
// decided it by name (null until then) and the version, and nothing the card
// already holds: no word, path, page or line comes back.
//
// `live_correction.list` and `live_correction.receipts` (#1694): the
// corrections the reader reaches, to draw their cards again after a reload,
// and one correction's receipts. Each asks `task:read` on the correction's
// task as well, inside the same query, so a reader who cannot open the task
// learns nothing of its corrections.
//
// The grant is `run:write`, the request's own key (ORCH33: the only key on
// `run`), asked at the correction's party inside the query, so a party grant
// on one client's site reads no other client's correction. A caller holding
// `run:write` nowhere is refused `SCOPE_NOT_GRANTED` before any id is looked
// at; for everyone else, not there, in another business, out of reach, a
// client's or malformed is one `NOT_FOUND`, so the read confirms no id, and a
// client's list is empty. They are the team's, as `task.execution` is, and
// never an agent's (`agent: 'never'`, `surface.ts`).

import {
  holdsAnywhere,
  isUuid,
  listReadableCorrections,
  readCoveredDecision,
  readReadableReceipts,
  RUN_COLLECTION,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type {
  LiveCorrectionListResult,
  LiveCorrectionReadResult,
  LiveCorrectionReceiptsResult,
} from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { invalid } from '../commands/operands.ts';
import { isInternalReader } from './tasks.ts';
import type { ReadRow } from './read-row.ts';

type Operands = { readonly correctionId: string };

const NO_RUN_WRITE = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);

const runWrite = (session: Session) =>
  ({ subjects: subjectsOf(session), collection: RUN_COLLECTION, action: 'write' }) as const;

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
  const covering = runWrite(session);
  if (!(await holdsAnywhere(tx, covering))) return NO_RUN_WRITE;
  if (!isInternalReader(session.roleKey) || !isUuid(correctionId)) return refuseNotFound();
  const correction = await readCoveredDecision(tx, correctionId, covering);
  return correction === undefined ? refuseNotFound() : { ok: true, correction };
}

export async function serveCorrectionList(
  tx: TenantQuery,
  session: Session,
): Promise<LiveCorrectionListResult | CommandRefusal> {
  if (!(await holdsAnywhere(tx, runWrite(session)))) return NO_RUN_WRITE;
  if (!isInternalReader(session.roleKey)) return { ok: true, corrections: [] };
  return { ok: true, corrections: await listReadableCorrections(tx, subjectsOf(session)) };
}

export async function serveCorrectionReceipts(
  tx: TenantQuery,
  session: Session,
  { correctionId }: Operands,
): Promise<LiveCorrectionReceiptsResult | CommandRefusal> {
  if (!(await holdsAnywhere(tx, runWrite(session)))) return NO_RUN_WRITE;
  if (!isInternalReader(session.roleKey) || !isUuid(correctionId)) return refuseNotFound();
  const read = await readReadableReceipts(tx, correctionId, subjectsOf(session));
  return read === undefined ? refuseNotFound() : { ok: true, ...read };
}

/** The read catalogue's correction rows (`catalogue.ts` spreads them in). */
export const CORRECTION_READS: {
  readonly [
    K in 'live_correction.read' | 'live_correction.list' | 'live_correction.receipts'
  ]: ReadRow<K>;
} = {
  // C80: a correction's decision; `run:write` at its party, asked inside the query.
  'live_correction.read': {
    identifiers: ['correctionId'],
    parse: parseCorrectionRead,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    disclosed: (answer) => ('correction' in answer ? answer.correction.correctionId : undefined),
    serve: serveCorrectionRead,
  },
  // #1694: the corrections both grants reach; a business read, so it discloses no one record.
  'live_correction.list': {
    identifiers: [],
    parse: () => ({ ok: true, operands: {} }),
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: serveCorrectionList,
  },
  // #1694: one correction's receipts, under the same two grants.
  'live_correction.receipts': {
    identifiers: ['correctionId'],
    parse: parseCorrectionRead,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    disclosed: (answer) =>
      'receipts' in answer && 'correctionId' in answer ? answer.correctionId : undefined,
    serve: serveCorrectionReceipts,
  },
};
