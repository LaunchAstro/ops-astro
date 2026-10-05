// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answers for Connections & signal's fleet (MP-14-7a), after the
// mockup's connector list, and its grants, tripwires and night round (MP-14-8). Test side only, like made-up-api.ts, which answers with
// them. Every source, client and agent is made up.

import type {
  ConnectionFleetResult,
  ConnectionSignalResult,
  ConnectionView,
  GrantView,
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

const grant = (
  n: number,
  state: GrantView['state'],
  access: GrantView['access'],
  client: GrantView['client'],
  redemptions: number,
): GrantView => ({
  id: `g-${String(n)}`,
  agentId: `a-${String(1 + (n % 2))}`,
  purpose: `T-${String(40 + n)}`,
  collections: ['task'],
  access,
  client,
  grantedAt: '2026-09-25T09:00:00.000Z',
  expiresAt: state === 'live' ? '2026-09-26T09:00:00.000Z' : '2026-09-25T13:00:00.000Z',
  endedAt: state === 'live' ? null : '2026-09-25T12:30:00.000Z',
  revocationCause: state === 'taken_back' ? 'delegation_revoked' : null,
  state,
  redemptions,
});

const GRANTS = [
  grant(1, 'live', 'read', { id: 'cl-1-0', label: 'Client 1' }, 3),
  grant(2, 'live', 'exec', { id: 'cl-1-1', label: 'Client 2' }, 0),
  grant(3, 'live', 'read', null, 5),
  grant(4, 'ran_out', 'read', { id: 'cl-1-2', label: null }, 1),
  grant(5, 'taken_back', 'exec', { id: 'cl-1-0', label: 'Client 1' }, 2),
];

const TRIPWIRES: ConnectionSignalResult['tripwires'] = [
  {
    id: 'tw-1',
    what: 'Quota near its ceiling',
    rule: 'Over 80% of the daily quota',
    watching: 'Klaviyo',
    state: 'armed',
    blockedReason: null,
    firedCount: 2,
    lastFiredAt: '2026-09-25T06:10:00.000Z',
    filedItem: 'T-51',
    filedNothing: null,
    note: null,
  },
  {
    id: 'tw-2',
    what: 'Spend jumps overnight',
    rule: 'Spend over twice the 7-day mean',
    watching: 'Google Ads',
    state: 'cannot_be_armed',
    blockedReason: 'No spend history yet',
    firedCount: 0,
    lastFiredAt: null,
    filedItem: null,
    filedNothing: null,
    note: null,
  },
];

const STEPS: NonNullable<ConnectionSignalResult['nightRound']>['steps'] = [
  {
    id: 'st-1',
    at: '2026-09-24T13:00:00.000Z',
    tone: 'plain',
    what: 'The window opened',
    who: 'Night round',
    say: 'Five grants checked.',
    cite: { kind: 'grants', ref: null, label: 'Grants' },
  },
  {
    id: 'st-2',
    at: '2026-09-24T15:20:00.000Z',
    tone: 'watch',
    what: 'A tripwire fired',
    who: 'Night round',
    say: 'Klaviyo quota at 82%.',
    cite: { kind: 'tripwires', ref: null, label: 'Tripwires' },
  },
  {
    id: 'st-3',
    at: '2026-09-24T22:10:00.000Z',
    tone: 'plain',
    what: 'The window closed',
    who: 'Night round',
    say: 'Filed one task.',
    cite: { kind: 'task', ref: 'T-51', label: 'T-51' },
  },
];

export const SIGNAL_READ: ConnectionSignalResult = {
  ok: true,
  grants: GRANTS,
  grantCounts: {
    live: GRANTS.filter((row) => row.state === 'live').length,
    ranOut: GRANTS.filter((row) => row.state === 'ran_out').length,
    takenBack: GRANTS.filter((row) => row.state === 'taken_back').length,
    liveExec: GRANTS.filter((row) => row.state === 'live' && row.access === 'exec').length,
  },
  tripwires: TRIPWIRES,
  tripwireCounts: {
    armed: TRIPWIRES.filter((row) => row.state === 'armed').length,
    cannotBeArmed: TRIPWIRES.filter((row) => row.state === 'cannot_be_armed').length,
  },
  nightRound: {
    roundOn: '2026-09-24',
    steps: STEPS,
    notClean: STEPS.filter((step) => step.tone !== 'plain').length,
  },
  roster: [
    {
      agentId: 'a-1',
      active: true,
      liveGrants: GRANTS.filter((row) => row.state === 'live' && row.agentId === 'a-1').length,
    },
    {
      agentId: 'a-2',
      active: true,
      liveGrants: GRANTS.filter((row) => row.state === 'live' && row.agentId === 'a-2').length,
    },
  ],
};
