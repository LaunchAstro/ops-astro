// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answers for Connections & signal's fleet (MP-14-7a), after the
// mockup's connector list. Test side only, like made-up-api.ts, which answers with
// them. Every source, client and agent is made up.

import type { ConnectionFleetResult, ConnectionView } from '../../packages/core-wire/src/index.ts';

const connection = (
  n: number,
  label: string,
  status: ConnectionView['status'],
  clients: number,
  failureClass: string | null = null,
): ConnectionView => ({
  id: `c-${String(n)}`,
  connectorKey: label.toLowerCase().replaceAll(' ', '_'),
  label,
  authMethod: 'oauth',
  status,
  failureClass,
  cadenceMinutes: 60,
  lastSyncedAt: status === 'broken' ? '2026-09-18T03:55:00.000Z' : '2026-09-25T17:55:00.000Z',
  lastAttemptAt: '2026-09-25T17:55:00.000Z',
  scope: 'read-only',
  readComponents: ['Reporting API'],
  executeComponents: [],
  custody: { secretId: `s-${String(n)}`, state: 'set' },
  clients: Array.from({ length: clients }, (_, at) => ({
    id: `cl-${String(n)}-${String(at)}`,
    label: `Client ${String(at + 1)}`,
  })),
  repairStartedAt: null,
  revision: 1,
});

const FLEET = [
  connection(1, 'Google Analytics 4', 'active', 6),
  connection(2, 'Search Console', 'active', 5),
  connection(3, 'Google Ads', 'active', 4),
  connection(4, 'Meta Ads', 'degraded', 3, 'throttled'),
  connection(5, 'Klaviyo', 'degraded', 2, 'quota_exhausted'),
  connection(6, 'LinkedIn Ads', 'broken', 2, 'auth_expired'),
  connection(7, 'Xero', 'broken', 3, 'quota_exhausted'),
];

export const FLEET_READ: ConnectionFleetResult = {
  ok: true,
  connections: FLEET,
  counts: {
    all: FLEET.length,
    active: FLEET.filter((row) => row.status === 'active').length,
    degraded: FLEET.filter((row) => row.status === 'degraded').length,
    broken: FLEET.filter((row) => row.status === 'broken').length,
    clientConnections: FLEET.reduce((sum, row) => sum + row.clients.length, 0),
  },
};
