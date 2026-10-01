// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up answers for SL09's two settings pages, Access (C32) and
// Telemetry (C34), and the people and clients every made-up read shares.
// Typed against the wire contract's read shapes, as `made-up-api.ts` is;
// test side only.

import type {
  AccessGrant,
  AccessReadResult,
  OperationsReadResult,
} from '../../packages/core-wire/src/index.ts';

export const NATHAN = { personId: 'p-nathan', name: 'Nathan' };
export const MIA = { personId: 'p-mia', name: 'Mia' };
export const MERIDIAN = { clientId: 'c-meridian', name: 'Meridian Dental' };
export const HARBOUR = { clientId: 'c-harbour', name: 'Harbour Physio' };
const PRIYA = { personId: 'p-priya', name: 'Priya Shah' };

const grant = (id: string, key: string, client: string | null = null): AccessGrant => {
  const [collection = '', action = 'read'] = key.split(':');
  const scope = { kind: client === null ? 'business' : 'party', id: client } as const;
  return { grantId: `g-${id}`, collection, action: action as AccessGrant['action'], scope };
};

const withPreview = (grants: readonly AccessGrant[]) => ({
  grants,
  // None of the made-up keys is a money key, so none asks the step-up (C59).
  permissions: grants.map(({ collection, action, scope }) => ({
    collection,
    action,
    scope,
    stepUp: false,
  })),
});

// Settings > Access (C32): two on the team, one client contact, one agent.
export const ACCESS: AccessReadResult = {
  ok: true,
  team: [
    {
      ...NATHAN,
      ...withPreview([grant('1', 'access:manage'), grant('2', 'settings:manage')]),
    },
    {
      ...MIA,
      ...withPreview([grant('3', 'task:write', MERIDIAN.clientId), grant('4', 'report:read')]),
    },
  ],
  clients: [{ ...PRIYA, ...withPreview([grant('5', 'review:comment', MERIDIAN.clientId)]) }],
  agents: [
    {
      agentActorId: 'a-reports',
      delegationId: 'd-reports',
      purpose: 'Weekly report drafts',
      person: MIA,
      expiresAt: '2026-10-10T00:00:00.000Z',
      permissions: [
        { collection: 'report', action: 'write', scope: { kind: 'record', id: 'r-1' } },
      ],
    },
  ],
  clientRecords: [MERIDIAN, HARBOUR],
};

// Settings > Telemetry (C34): each of the four service states and a source switched off.
export const OPERATIONS: OperationsReadResult = {
  ok: true,
  unattended: [],
  privacyIncidents: [],
  breachRunbook: null,
  serviceHealth: {
    checkedAt: '2026-09-26T00:05:00.000Z',
    sources: [
      { source: 'watcher', state: 'read', fault: null },
      { source: 'error-sink', state: 'read', fault: null },
      { source: 'tracing', state: 'off', fault: null },
    ],
    services: [
      {
        source: 'watcher',
        name: 'api',
        state: 'healthy',
        lastObservedAt: '2026-09-26T00:04:30.000Z',
      },
      {
        source: 'watcher',
        name: 'worker',
        state: 'stale',
        lastObservedAt: '2026-09-25T21:10:00.000Z',
      },
      {
        source: 'error-sink',
        name: 'mail relay',
        state: 'service-failure',
        lastObservedAt: '2026-09-26T00:01:00.000Z',
      },
      { source: 'watcher', name: 'backups', state: 'never-observed', lastObservedAt: null },
    ],
  },
};
