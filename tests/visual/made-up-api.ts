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
  CapabilitiesResult,
  CommandRefusal,
  InboxCountResult,
  InboxReadResult,
  InternalTaskDetail,
  InternalTaskRead,
  PersonListResult,
  ProposalView,
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

// One proposal whose newest version waits at an armed gate, so the task page
// draws the mockup's gate box (states.json `gate`). The gate's deadline sits
// after the harness clock, so it reads pending and the controls are offered.
const DIGEST = 'sha256:7c41e8f9a2d6b3915e0c47a8fd23b6c1e94a7f80d5b2c6e31a94f7d2b8c05e4a2';
const PROPOSAL: ProposalView = {
  lineageId: 'l-1',
  state: 'live',
  versions: [
    {
      versionId: 'v-2',
      version: 2,
      purpose: 'contract_review_pack',
      maximumMinor: 12_000,
      currency: 'AUD',
      payloadDigest: DIGEST,
      payload: { pack: 'Signed scope, two variations and the renewal terms, in one PDF.' },
      supersededAt: null,
      runId: null,
      evidence: null,
      gate: {
        id: 'g-2',
        state: 'pending',
        round: 1,
        expiresAt: '2026-10-03T00:00:00.000Z',
        expired: false,
        payloadDigest: DIGEST,
      },
    },
  ],
  decisions: [],
  reservations: [],
};

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
  proposals: [PROPOSAL],
  capCurrency: 'AUD',
  envelope: null,
  alerts: [],
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
} as const satisfies Partial<Record<ReadName, unknown>>;

/** The reads the harness answers; a read missing here draws its "could not be read" state. */
export const MADE_UP_READS: readonly string[] = Object.keys(READS);

// The collections a variant can answer with no rows: the screens whose empty
// state a person meets (the board and the inbox).
const EMPTY: { readonly 'task.board': TaskBoardResult; readonly 'inbox.read': InboxReadResult } = {
  'task.board': { ok: true, tasks: [] },
  'inbox.read': { ok: true, inbox: [] },
};

// The server's one refusal shape, under the status the register carries it at.
const REFUSAL: CommandRefusal = { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] };

/**
 * The made-up answers with some reads in another state (UI-STATES), so the
 * harness can photograph a read's other renderings. A read not named keeps its
 * default answer; with no variant, every answer is the default.
 */
export interface MadeUpVariant {
  /** Answered with no rows: the screen's empty state. */
  readonly empty?: readonly (keyof typeof EMPTY)[];
  /** Answered 503 with no refusal body: the server failing, "could not be read". */
  readonly unavailable?: readonly ReadName[];
  /** Refused with the server's refusal shape: the screen's denied state. */
  readonly refused?: readonly ReadName[];
  /** Never answered: the screen stays on its loading state. */
  readonly pending?: readonly ReadName[];
}

export type MadeUpAnswer = { status: number; json?: unknown } | { pending: true };

/**
 * The made-up answer for one request path, or nothing for a path it does not
 * know. `/api/b/<business>/<collection>/<verb>` is a read's path (`pathOf`);
 * the tab's live stream is answered as down, so nothing streams in a capture.
 */
export function madeUpAnswer(
  pathname: string,
  variant: MadeUpVariant = {},
): MadeUpAnswer | undefined {
  const match = /^\/api\/b\/[^/]+\/(.+)$/u.exec(pathname);
  if (match === null) return undefined;
  const rest = match[1] ?? '';
  if (rest === 'live' || rest.startsWith('live/')) return { status: 503 };
  const name = rest.replace('/', '.');
  const named = (list: readonly string[] | undefined): boolean => list?.includes(name) ?? false;
  if (named(variant.pending)) return { pending: true };
  if (named(variant.unavailable)) return { status: 503 };
  if (named(variant.refused)) return { status: 403, json: REFUSAL };
  if (named(variant.empty)) return { status: 200, json: EMPTY[name as keyof typeof EMPTY] };
  if (name in READS) return { status: 200, json: READS[name as keyof typeof READS] };
  return undefined;
}

/**
 * Answers a context's reads from the made-up set, in the variant's states.
 * Registered after the side's own routes, so it runs first (Playwright runs
 * the last match first); a path it does not know falls through to them. A
 * pending read is never answered: closing the context ends it.
 */
export async function answerMadeUp(
  context: BrowserContext,
  variant: MadeUpVariant = {},
): Promise<void> {
  await context.route('**/api/b/**', async (route) => {
    const answer = madeUpAnswer(new URL(route.request().url()).pathname, variant);
    if (answer !== undefined && 'pending' in answer) return;
    await (answer === undefined ? route.fallback() : route.fulfill(answer));
  });
}
