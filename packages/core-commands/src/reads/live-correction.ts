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
  coveredAt,
  holdsAnywhere,
  isUuid,
  readCoveredDecision,
  readPageSnapshot,
  RUN_COLLECTION,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type {
  LiveCorrectionLocateResult,
  LiveCorrectionReadResult,
} from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { invalid } from '../commands/operands.ts';
import { isInternalReader } from './tasks.ts';
import type { Found } from './read-row.ts';

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

type LocateOperands = { readonly recordId: string; readonly pageUrl: string };

export function parseCorrectionLocate(
  body: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly operands: LocateOperands }
  | { readonly ok: false; readonly refusal: CommandRefusal } {
  const { recordId, pageUrl } = body;
  if (typeof recordId !== 'string') {
    return {
      ok: false,
      refusal: invalid('recordId', 'Send recordId as the task’s identifier or its key.'),
    };
  }
  return typeof pageUrl === 'string'
    ? { ok: true, operands: { recordId, pageUrl } }
    : { ok: false, refusal: invalid('pageUrl', 'Send pageUrl as the page’s address.') };
}

/**
 * `live_correction.locate` (C80, the sidebar door): the file behind a page of
 * the task's own client's site, as the correction job's snapshot holds it, so
 * the API never holds a site credential. The task is the declaration's
 * (`task:read` on it); the caller's `run:write` is asked at the task's client,
 * as a request asks it. Another client's page, no client's, another spelling,
 * a page with no snapshot yet and a grant on another client are one
 * `NOT_FOUND`, the answer to a page that names nothing.
 */
export async function serveCorrectionLocate(
  tx: TenantQuery,
  session: Session,
  { pageUrl }: LocateOperands,
  { spine, recordId }: Found,
): Promise<LiveCorrectionLocateResult | CommandRefusal> {
  if (recordId === undefined) return refuseNotFound();
  const page = await readPageSnapshot(tx, spine.taskTypeId, recordId, pageUrl);
  if (page === undefined) return refuseNotFound();
  const covering = { subjects: subjectsOf(session), collection: RUN_COLLECTION, action: 'write' };
  if (!(await coveredAt(tx, covering, page.partyId))) return refuseNotFound();
  return {
    ok: true,
    target: {
      partyId: page.partyId,
      taskId: recordId,
      path: page.path,
      pageUrl: page.pageUrl,
      baseRevision: page.revision,
      before: page.text,
    },
  };
}
