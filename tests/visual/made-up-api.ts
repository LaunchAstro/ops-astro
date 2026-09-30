// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answers for the width-and-theme harness (UI-POLISH).
//
// The harness serves the app with its API at a dead port, so every data
// screen used to be photographed on its "could not be read" state: no
// sideways scroll proven on an error, nothing about the look. These answers
// let each screen draw rows. They are typed against the wire contract's own
// read shapes, so a changed read fails the typecheck here rather than drawing
// a screen from a shape the API no longer sends. Test side only: the page
// asks the same addresses it asks the real API; nothing here is a back end.
//
// The rows follow the pinned mockup's Projects board, so a capture reads
// against the mockup's page. Every name and client is made up.

import type {
  AccessGrant,
  AccessReadResult,
  CapabilitiesResult,
  InboxCountResult,
  InboxReadResult,
  InternalTaskDetail,
  InternalTaskRead,
  OperationsReadResult,
  PersonListResult,
  QueueResult,
  SettingsReadResult,
  TaskBoardResult,
  TaskExecutionResult,
  TaskStateView,
  TaskSummary,
} from '../../packages/core-wire/src/index.ts';
import type { BrowserContext } from 'playwright';
import type { ReadName } from '../../apps/web/src/operations/read-names.ts';

const STATE = {
  active: { id: 's-active', key: 'active', label: 'Active', machineCategory: 'started' },
  waiting: {
    id: 's-waiting',
    key: 'waiting',
    label: 'Waiting on client',
    machineCategory: 'backlog',
  },
  hold: { id: 's-hold', key: 'hold', label: 'On hold', machineCategory: 'unstarted' },
} as const satisfies Record<string, TaskStateView>;

const NATHAN = { personId: 'p-nathan', name: 'Nathan' };
const MIA = { personId: 'p-mia', name: 'Mia' };

const task = (
  n: number,
  title: string,
  state: TaskStateView,
  due: string | null,
  assignee: TaskSummary['assignee'] = NATHAN,
): TaskSummary => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  key: `T-${String(n)}`,
  title,
  state,
  assignee,
  due,
  priority: null,
  completedAt: null,
  revision: 1,
});

// The harness clock is 2026-09-26; dates sit either side of it.
export const TASKS: readonly TaskSummary[] = [
  task(1, 'Contract review pack, 31 July', STATE.active, '2026-09-30'),
  task(6, 'Renewal pack, 14 August', STATE.active, '2026-10-07'),
  task(9, 'Sign off the Meridian ad run rate, 29% over budget', STATE.active, '2026-09-18'),
  task(13, 'Approve the four review replies before they go out', STATE.active, '2026-09-26'),
  task(15, 'Ads rebuild: cost per enquiry', STATE.active, '2026-10-06', MIA),
  task(17, 'Shopping feed clean-up', STATE.active, '2026-10-05'),
  task(24, 'New patient offer campaign', STATE.active, '2026-10-09'),
  task(4, 'Budget pacing fix', STATE.waiting, '2026-10-01', null),
  task(33, 'Paid social rebuild', STATE.hold, null),
];

const DETAIL: InternalTaskDetail = {
  ...(TASKS[0] as TaskSummary),
  description:
    'Pull the signed scope, the two variations and the renewal terms into one pack for review.',
  history: [
    { at: '2026-09-24T01:10:00.000Z', actorId: NATHAN.personId, operation: 'task.create' },
    { at: '2026-09-25T03:40:00.000Z', actorId: NATHAN.personId, operation: 'task.update' },
  ],
  comments: [
    {
      id: 'c-1',
      audience: 'internal',
      author: NATHAN.personId,
      body: 'Variation two is still unsigned; chase before the pack goes out.',
      comment_type: 'note',
      posted_at: '2026-09-25T04:00:00.000Z',
      edited_at: null,
      source: 'app',
    },
  ],
  proposals: [],
  capCurrency: 'AUD',
  envelope: null,
  alerts: [],
};

const MERIDIAN = { clientId: 'c-meridian', name: 'Meridian Dental' };
const HARBOUR = { clientId: 'c-harbour', name: 'Harbour Physio' };
const PRIYA = { personId: 'p-priya', name: 'Priya Shah' };

const grant = (id: string, key: string, client: string | null = null): AccessGrant => {
  const [collection = '', action = 'read'] = key.split(':');
  const scope = { kind: client === null ? 'business' : 'party', id: client } as const;
  return { grantId: `g-${id}`, collection, action: action as AccessGrant['action'], scope };
};

const withPreview = (grants: readonly AccessGrant[]) => ({
  grants,
  permissions: grants.map(({ collection, action, scope }) => ({ collection, action, scope })),
});

// Settings > Access (C32): two on the team, one client contact, one agent.
const ACCESS: AccessReadResult = {
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
const OPERATIONS: OperationsReadResult = {
  ok: true,
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

const READS = {
  'task.board': { ok: true, tasks: TASKS } satisfies TaskBoardResult,
  'task.read': { ok: true, task: DETAIL } satisfies InternalTaskRead,
  'person.list': { ok: true, persons: [NATHAN, MIA] } satisfies PersonListResult,
  'settings.read': {
    ok: true,
    settings: [
      {
        key: 'four_eyes_threshold',
        value: 500,
        valueType: 'numeric',
        updatedAt: '2026-09-20T00:00:00.000Z',
        updatedByActorId: NATHAN.personId,
        revision: 2,
      },
      {
        key: 'client_sign_off_required',
        value: true,
        valueType: 'boolean',
        updatedAt: '2026-09-20T00:00:00.000Z',
        updatedByActorId: NATHAN.personId,
        revision: 1,
      },
    ],
  } satisfies SettingsReadResult,
  'session.capabilities': {
    ok: true,
    personId: NATHAN.personId,
    businessKey: 'alpha',
    grants: [
      { collection: 'tasks', action: 'read' },
      { collection: 'tasks', action: 'write' },
      { collection: 'settings', action: 'manage' },
    ],
  } satisfies CapabilitiesResult,
  'task.queue': { ok: true, queue: [], alerts: [], outages: [] } satisfies QueueResult,
  'task.execution': {
    execution: { outcome: 'no-run', runs: [], events: [], complete: true, next: null },
  } satisfies TaskExecutionResult,
  'inbox.read': {
    ok: true,
    inbox: [
      {
        id: 'i-1',
        reason: 'decision',
        workState: 'open',
        access: 'readable',
        owed: true,
        counted: true,
        raisedAt: '2026-09-25T22:00:00.000Z',
        closedAt: null,
        seenAt: null,
        lastDelivery: 'delivered',
        task: { key: 'T-9', title: 'Sign off the Meridian ad run rate, 29% over budget' },
      },
      {
        id: 'i-2',
        reason: 'assignment',
        workState: 'open',
        access: 'readable',
        owed: true,
        counted: true,
        raisedAt: '2026-09-25T20:30:00.000Z',
        closedAt: null,
        seenAt: '2026-09-25T21:00:00.000Z',
        lastDelivery: 'delivered',
        task: { key: 'T-13', title: 'Approve the four review replies before they go out' },
      },
    ],
  } satisfies InboxReadResult,
  'inbox.count': { ok: true, owed: 2 } satisfies InboxCountResult,
  'access.read': ACCESS,
  'operations.read': OPERATIONS,
} as const satisfies Partial<Record<ReadName, unknown>>;

/** The reads the harness answers; a read missing here draws its "could not be read" state. */
export const MADE_UP_READS: readonly string[] = Object.keys(READS);

/**
 * The made-up answer for one request path, or nothing for a path it does not
 * know. `/api/b/<business>/<collection>/<verb>` is a read's path (`pathOf`);
 * the tab's live stream is answered as down, so nothing streams in a capture.
 */
export function madeUpAnswer(pathname: string): { status: number; json?: unknown } | undefined {
  const match = /^\/api\/b\/[^/]+\/(.+)$/u.exec(pathname);
  if (match === null) return undefined;
  const rest = match[1] ?? '';
  if (rest === 'live' || rest.startsWith('live/')) return { status: 503 };
  const name = rest.replace('/', '.');
  if (name in READS) return { status: 200, json: READS[name as keyof typeof READS] };
  return undefined;
}

/**
 * Answers a context's reads from the made-up set. Registered after the side's
 * own routes, so it runs first (Playwright runs the last match first); a path
 * it does not know falls through to them.
 */
export async function answerMadeUp(context: BrowserContext): Promise<void> {
  await context.route('**/api/b/**', async (route) => {
    const answer = madeUpAnswer(new URL(route.request().url()).pathname);
    await (answer === undefined ? route.fallback() : route.fulfill(answer));
  });
}
