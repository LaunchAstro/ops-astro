// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answers for Connections & signal, sections 001 to 008 (SL13,
// MP-14-7a and MP-14-8): the fleet and the signal, after the mockup's
// connector list. Test side only, like made-up-api.ts, which answers with
// them. Every source, client and agent is made up.

import type {
  ConnectionFleetResult,
  ConnectionSignalResult,
  ConnectionView,
} from '../../packages/core-wire/src/index.ts';

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

export const SIGNAL_READ: ConnectionSignalResult = {
  ok: true,
  leases: [
    {
      id: 'g-1',
      agentId: 'agent-reporting',
      purpose: 'Monthly report pull',
      collections: ['record'],
      access: 'read',
      client: { id: 'cl-1-0', label: 'Client 1' },
      grantedAt: '2026-09-25T13:00:00.000Z',
      expiresAt: '2026-09-26T13:00:00.000Z',
      endedAt: null,
      revocationCause: null,
      state: 'live',
      redemptions: 4,
    },
    {
      id: 'g-2',
      agentId: 'agent-ads',
      purpose: 'Budget pacing check',
      collections: ['record'],
      access: 'read',
      client: null,
      grantedAt: '2026-09-24T13:00:00.000Z',
      expiresAt: '2026-09-25T13:00:00.000Z',
      endedAt: '2026-09-25T13:00:00.000Z',
      revocationCause: null,
      state: 'ran_out',
      redemptions: 2,
    },
  ],
  leaseCounts: { live: 1, ranOut: 1, takenBack: 0, liveExec: 0 },
  tripwires: [
    {
      id: 't-1',
      what: 'Ad spend over pace',
      rule: 'Spend runs 20% over the month to date',
      watching: 'Google Ads',
      state: 'armed',
      blockedReason: null,
      firedCount: 1,
      lastFiredAt: '2026-09-24T21:10:00.000Z',
      filedItem: 'T-9',
      filedNothing: null,
      note: null,
    },
    {
      id: 't-2',
      what: 'Site down',
      rule: 'Uptime check fails twice',
      watching: 'UptimeRobot',
      state: 'cannot_be_armed',
      blockedReason: 'The uptime source is not connected yet.',
      firedCount: 0,
      lastFiredAt: null,
      filedItem: null,
      filedNothing: null,
      note: null,
    },
  ],
  tripwireCounts: { armed: 1, cannotBeArmed: 1 },
  nightRound: {
    roundOn: '2026-09-25',
    steps: [
      {
        id: 'n-1',
        at: '2026-09-25T13:00:00.000Z',
        tone: 'plain',
        what: 'Round started',
        who: 'agent-reporting',
        say: 'Seven sources to read.',
        cite: null,
      },
      {
        id: 'n-2',
        at: '2026-09-25T14:20:00.000Z',
        tone: 'bad',
        what: 'LinkedIn Ads not read',
        who: 'agent-reporting',
        say: 'Its authorisation has expired.',
        cite: { kind: 'tripwires', ref: 't-1', label: 'Tripwires' },
      },
    ],
    notClean: 1,
  },
  roster: [
    { agentId: 'agent-reporting', active: true, liveGrants: 1 },
    { agentId: 'agent-ads', active: true, liveGrants: 0 },
  ],
};
