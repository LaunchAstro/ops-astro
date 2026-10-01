// SPDX-License-Identifier: AGPL-3.0-only
//
// `live_correction.read` (C80): one correction's decision, for its card. It
// answers the state as the request and decide commands name it, the person
// who decided it by name (null until then) and the version, and nothing the
// card already holds: no word, path, page or line comes back.
//
// The grant is `run:read`, the request's own collection, asked at the
// correction's party inside the query (`readCoveredDecision`), so a party
// grant on one client's site reads no other client's correction. A person
// reads as a member of the team, as `task.execution` is read; an agent reads
// under its delegation, which must carry `run` and `read`, on its own task
// only, with the delegating person's live grant as the ceiling. Not there, in
// another business, out of reach, malformed: one `NOT_FOUND`, so the read is
// no oracle for whether an id exists.

import {
  isUuid,
  readCoveredDecision,
  RUN_COLLECTION,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Delegation, Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { LiveCorrectionReadResult } from '../../../core-wire/src/index.ts';
import { refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { invalid } from '../commands/operands.ts';
import { refused, type HandlerOutcome } from '../commands/outcome.ts';
import { isInternalReader } from './tasks.ts';

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

export async function serveCorrectionRead(
  tx: TenantQuery,
  session: Session,
  { correctionId }: Operands,
): Promise<LiveCorrectionReadResult | CommandRefusal> {
  if (!isInternalReader(session.roleKey) || !isUuid(correctionId)) return refuseNotFound();
  const correction = await readCoveredDecision(tx, correctionId, {
    subjects: subjectsOf(session),
    collection: RUN_COLLECTION,
    action: 'read',
  });
  return correction === undefined ? refuseNotFound() : { ok: true, correction };
}

export async function readCorrectionAsAgent(
  tx: TenantQuery,
  { correctionId }: Operands,
  delegation: Delegation,
): Promise<HandlerOutcome> {
  const carries =
    delegation.collections.includes(RUN_COLLECTION) && delegation.actions.includes('read');
  if (!carries || !isUuid(correctionId)) return refused(refuseNotFound());
  const correction = await readCoveredDecision(
    tx,
    correctionId,
    {
      subjects: [{ kind: 'person', id: delegation.delegatePersonId }],
      collection: RUN_COLLECTION,
      action: 'read',
    },
    delegation.purposeScope.id,
  );
  return correction === undefined
    ? refused(refuseNotFound())
    : { recordId: null, revision: null, detail: { correction } };
}
