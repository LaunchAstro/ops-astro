// SPDX-License-Identifier: AGPL-3.0-only
//
// `connector.repair` (MP-14-7a, CS-14.12): record `connector repair started`.
//
// The envelope has already checked `custody:manage` business-wide and refused
// every agent (the row is `agent: never`). That check is not held to the
// write, so the start asks `custody:manage` again straight after it reads the
// connection, with the caller's custody grants held for share
// (`holdCoveringGrants`, as `task.duplicate` holds its own): a revocation that
// committed first refuses the start before it answers anything about the
// connection, and one that comes second waits for it to commit. Then the
// connection: it must be one of this business's, broken, and at the revision
// the caller saw if they named one. The repair is recorded against that exact
// revision and nothing else happens: re-authorising is the broker's (AW-01),
// and it passes the approval gate on this revision before anything leaves the
// system.

import {
  isRepairRefusal,
  isUuid,
  startRepair,
  subjectsOf,
  type RepairRefusal,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import {
  checkAuthorityAt,
  holdCoveringGrants,
  lockedInstant,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const REVISION_FIXES = [
  'Send expectedRevision as the whole number connection.fleet showed, or leave it out.',
];

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** `custody:manage` business-wide, judged at the instant the grants are held. */
async function stillManagesCustody(tx: TenantQuery, context: CommandContext): Promise<boolean> {
  const subjects = subjectsOf(context.session);
  await holdCoveringGrants(tx, subjects, 'custody');
  const at = await lockedInstant(tx);
  const decision = await checkAuthorityAt(
    tx,
    subjects,
    { collection: 'custody', action: 'manage', scope: { kind: 'business', id: null } },
    at,
  );
  return decision.ok;
}

/** The command's answer to each way the start is refused. */
function refusalOf(refusal: RepairRefusal): CommandRefusal {
  switch (refusal.refused) {
    case 'not-found':
      return refuseNotFound();
    case 'not-granted':
      return refuseCommand(
        'SCOPE_NOT_GRANTED',
        [],
        ['no live grant covers it', 'ask a holder who may delegate'],
      );
    case 'stale':
      return refuseCommand(
        'VERSION_STALE',
        [`revision=${refusal.revision}`],
        ['Read the fleet again and start the repair on the revision it is at now.'],
      );
    case 'not-broken':
      return refuseCommand(
        'TRANSITION_NOT_PERMITTED',
        [`status=${refusal.status}`],
        ['Only a broken connection is repaired; this one is not broken.'],
      );
  }
}

export async function startConnectorRepair(
  tx: TenantQuery,
  context: CommandContext,
  request: { readonly connectionId: string; readonly expectedRevision?: unknown },
): Promise<HandlerOutcome> {
  const { expectedRevision } = request;
  if (expectedRevision !== undefined && !isRevision(expectedRevision)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['expectedRevision'], REVISION_FIXES));
  }
  // Another business's connection is not in this transaction's rows at all
  // (RLS), so it answers exactly as a fabricated or malformed identifier does.
  if (!isUuid(request.connectionId)) return refused(refuseNotFound());
  const started = await startRepair(tx, {
    connectionId: request.connectionId,
    actorId: context.session.actorId,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    admitted: async () => await stillManagesCustody(tx, context),
  });
  if (isRepairRefusal(started)) return refused(refusalOf(started));
  return applied(started.id, started.connectionRevision, {
    repairId: started.id,
    connectionId: started.connectionId,
    connectionRevision: started.connectionRevision,
    state: 'awaiting approval',
  });
}
