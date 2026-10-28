// SPDX-License-Identifier: AGPL-3.0-only
//
// A read's grant check, apart from the pipeline that asks it (`dispatch.ts`): at the door,
// and again after `serve` for a row judged last (`SpineRow.judgedLast`, S2114-3).

import { checkAuthority, subjectsOf, wayfinderFacts } from '../../../core-records/src/index.ts';
import type { TenantQuery, Session, ScopeRequest } from '../../../core-records/src/index.ts';
import { refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import type { declarationOf } from '../../../core-wire/src/index.ts';
import type { ReadOperands } from './requests.ts';
import type { ReadName, ReadRow } from './catalogue.ts';

/** The grant check of a row that asks one: the refusal it answers, or none. */
export async function grantRefusal<K extends ReadName>(
  tx: TenantQuery,
  session: Session,
  row: ReadRow<K>,
  declaration: ReturnType<typeof declarationOf>,
  operands: ReadOperands[K],
  recordId: string | undefined,
): Promise<CommandRefusal | undefined> {
  const asked: ScopeRequest = {
    // The action is the declaration's, and so is the collection unless the
    // row names the one the request is really about (`preset.plan`).
    collection:
      typeof row.authority === 'function' ? row.authority(operands) : declaration.collection,
    action: declaration.action,
    // A record-scoped grant is checked against the record named, exactly as
    // a targeted command's is. A business-scoped grant covers both, which is
    // what `effectiveGrants` already means by `scope_kind = 'business'`.
    scope:
      recordId === undefined ? { kind: 'business', id: null } : { kind: 'record', id: recordId },
  };
  let authorised = await checkAuthority(tx, subjectsOf(session), asked);
  // A grant scoped to a map covers its tickets too (W12), as on the command path.
  const map =
    authorised.ok || recordId === undefined || asked.collection !== 'task'
      ? null
      : ((await wayfinderFacts(tx, recordId))?.mapId ?? null);
  // Read again, held until the read is served: a move that committed since is
  // seen, and none can commit before the answer is read. The map grant is asked
  // after that read, so a grant that runs out while it waits is not counted (S2114-5).
  if (
    !authorised.ok &&
    map !== null &&
    recordId !== undefined &&
    map !== recordId &&
    (await wayfinderFacts(tx, recordId, true))?.mapId === map
  ) {
    const again = await checkAuthority(tx, subjectsOf(session), {
      ...asked,
      scope: { kind: 'record', id: map },
    });
    if (again.ok) authorised = again;
  }
  if (authorised.ok) return undefined;
  // An external party is a session with no membership (`ReadRow.outsiderNotFound`).
  if (session.roleKey === null && row.outsiderNotFound) return refuseNotFound();
  return authorised.refusal;
}
