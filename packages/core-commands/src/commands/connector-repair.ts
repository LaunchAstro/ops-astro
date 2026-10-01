// SPDX-License-Identifier: AGPL-3.0-only
//
// `connector.repair` (MP-14-7a, CS-14.12): record `connector repair started`.
//
// The envelope has already checked `custody:manage` business-wide and refused
// every agent (the row is `agent: never`). What is left is the connection: it
// must be one of this business's, broken, and at the revision the caller saw
// if they named one. The repair is recorded against that exact revision and
// nothing else happens: re-authorising is the broker's (AW-01), and it passes
// the approval gate on this revision before anything leaves the system.

import {
  isRepairRefusal,
  isUuid,
  startRepair,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const REVISION_FIXES = [
  'Send expectedRevision as the whole number connection.fleet showed, or leave it out.',
];

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
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
  });
  if (isRepairRefusal(started)) {
    switch (started.refused) {
      case 'not-found':
        return refused(refuseNotFound());
      case 'stale':
        return refused(
          refuseCommand(
            'VERSION_STALE',
            [`revision=${started.revision}`],
            ['Read the fleet again and start the repair on the revision it is at now.'],
          ),
        );
      case 'not-broken':
        return refused(
          refuseCommand(
            'TRANSITION_NOT_PERMITTED',
            [`status=${started.status}`],
            ['Only a broken connection is repaired; this one is not broken.'],
          ),
        );
    }
  }
  return applied(started.id, started.connectionRevision, {
    repairId: started.id,
    connectionId: started.connectionId,
    connectionRevision: started.connectionRevision,
    state: 'awaiting approval',
  });
}
