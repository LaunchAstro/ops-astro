// SPDX-License-Identifier: AGPL-3.0-only
//
// `connection.fleet` (MP-14-7a): the connector fleet on Connections & signal.
//
// The rows are filtered by the scopes the caller holds `connection:read` at,
// inside the statement, in the serving transaction (`listConnections`): a
// business-wide reader sees every connection, a client-scoped reader the
// connections serving that client and only that client in each list, and a
// caller holding the key nowhere is refused rather than shown an empty fleet.
// The counts the facets, tiles and banner draw are taken from these same
// rows, so they cannot disagree with them.

import {
  grantedScopes,
  listConnections,
  subjectsOf,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { ConnectionView } from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import type { ReadResult } from './requests.ts';

export async function readConnectionFleet(
  tx: TenantQuery,
  session: Session,
): Promise<ReadResult | CommandRefusal> {
  const scopes = await grantedScopes(tx, subjectsOf(session), 'connection', 'read');
  if (scopes.length === 0) {
    return refuseCommand(
      'SCOPE_NOT_GRANTED',
      ['connection:read'],
      ['no live grant covers it', 'ask a holder who may delegate'],
    );
  }
  const rows = await listConnections(tx, scopes);
  const connections: ConnectionView[] = rows.map((row) => ({
    id: row.id,
    connectorKey: row.connectorKey,
    label: row.label,
    authMethod: row.authMethod,
    status: row.status,
    failureClass: row.failureClass,
    cadenceMinutes: row.cadenceMinutes,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    scope: row.scope,
    readComponents: row.readComponents,
    executeComponents: row.executeComponents,
    custody: { secretId: row.secretId, state: row.secretSet ? 'set' : 'not set' },
    clients: row.clients,
    repairStartedAt: row.repairStartedAt?.toISOString() ?? null,
    revision: row.revision,
  }));
  const count = (status: ConnectionView['status']): number =>
    connections.filter((one) => one.status === status).length;
  return {
    ok: true,
    connections,
    counts: {
      all: connections.length,
      active: count('active'),
      degraded: count('degraded'),
      broken: count('broken'),
      clientConnections: connections.reduce((sum, one) => sum + one.clients.length, 0),
    },
  };
}
