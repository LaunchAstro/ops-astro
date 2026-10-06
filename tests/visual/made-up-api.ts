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
// The rows (made-up-rows.ts) follow the pinned mockup's Projects board, so a capture reads
// against the mockup's page. Every name and client is made up.

import type {
  AllowanceResult,
  CapabilitiesResult,
  ClientListResult,
  CommandRefusal,
  InboxCountResult,
  InboxReadResult,
  InternalTaskRead,
  PersonListResult,
  QueueResult,
  SecretListResult,
  SessionPersonResult,
  SettingsReadResult,
  TagListResult,
  TaskBoardResult,
  TaskSearchResult,
  TaskTodosResult,
  TeamListResult,
} from '../../packages/core-wire/src/index.ts';
import type { BrowserContext } from 'playwright';
import type { ReadName } from '../../apps/web/src/operations/read-names.ts';
import { ACCESS, HARBOUR, MERIDIAN, MIA, NATHAN, OPERATIONS } from './made-up-access.ts';
import { AGENT_READS } from './made-up-agent.ts';
import { AUTOMATION_REGISTRY } from './made-up-automations.ts';
import { FLEET_READ, SIGNAL_READ } from './made-up-connections.ts';
import { EXECUTION, RECEIPT } from './made-up-data.ts';
import { DETAIL, LEDGER, STATE, TAGS, TASKS, TODOS } from './made-up-rows.ts';
import { WAYFINDER_READS } from './made-up-wayfinder.ts';

export { TASKS } from './made-up-rows.ts';

/** One business setting as `settings.read` answers it, last written by Nathan. */
const setting = (key: string, value: number | boolean, revision: number) => ({
  key,
  value,
  valueType: typeof value === 'boolean' ? ('boolean' as const) : ('numeric' as const),
  updatedAt: '2026-09-20T00:00:00.000Z',
  updatedByActorId: NATHAN.personId,
  revision,
});

const READS = {
  'task.board': {
    ok: true,
    tasks: TASKS,
    changedAt: '2026-09-25T04:00:00.000Z',
    viewer: NATHAN.personId,
    owed: 0,
  } satisfies TaskBoardResult,
  'task.read': {
    ok: true,
    task: DETAIL,
    states: Object.values(STATE),
  } satisfies InternalTaskRead,
  'task.todos': { ok: true, todos: TODOS } satisfies TaskTodosResult,
  'tag.list': { ok: true, tags: TAGS } satisfies TagListResult,
  'person.list': { ok: true, persons: [NATHAN, MIA] } satisfies PersonListResult,
  'settings.read': {
    ok: true,
    settings: [
      setting('four_eyes_threshold', 500, 2),
      setting('client_sign_off_required', true, 1),
      setting('conversation_window_days', 30, 1),
      setting('retention_window_days', 365, 1),
    ],
    planningCap: { limitMinor: 5000, currency: 'AUD', set: false },
  } satisfies SettingsReadResult,
  // The person's own store (MP-2-11a): no appearance, so the capture's colour
  // scheme draws; two dismissals no page draws, so the reset has a count.
  'preference.read': {
    ok: true,
    preferences: { 'tips.dismissed': { 'agency:settings#one': 1, 'agency:settings#two': 1 } },
  },
  'session.capabilities': {
    ok: true,
    personId: NATHAN.personId,
    businessKey: 'alpha',
    grants: [
      { collection: 'tasks', action: 'read' },
      { collection: 'tasks', action: 'write' },
      { collection: 'settings', action: 'manage' },
      { collection: 'custody', action: 'manage' },
    ],
  } satisfies CapabilitiesResult,
  'task.queue': { ok: true, queue: [], alerts: [], outages: [] } satisfies QueueResult,
  'task.execution': EXECUTION,
  'task.receipt': { ok: true, ...RECEIPT },
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
        client: MERIDIAN,
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
        client: HARBOUR,
      },
      {
        id: 'i-3',
        reason: 'run_finished',
        workState: 'open',
        access: 'readable',
        owed: false,
        counted: false,
        raisedAt: '2026-09-25T18:10:00.000Z',
        closedAt: null,
        seenAt: null,
        lastDelivery: 'delivered',
        task: { key: 'T-17', title: 'Shopping feed clean-up' },
      },
    ],
  } satisfies InboxReadResult,
  'inbox.count': { ok: true, owed: 2 } satisfies InboxCountResult,
  'session.person': { ok: true, person: { name: NATHAN.name } } satisfies SessionPersonResult,
  'team.list': {
    ok: true,
    you: NATHAN.personId,
    people: [
      { personId: NATHAN.personId, name: NATHAN.name, availability: null },
      { personId: MIA.personId, name: MIA.name, availability: { state: 'away', reason: 'Leave' } },
    ],
  } satisfies TeamListResult,
  'task.ledger': LEDGER,
  'task.search': {
    ok: true,
    hits: TASKS.slice(0, 3).map(({ id, key, title }) => ({ id, key, title })),
  } satisfies TaskSearchResult,
  'access.read': ACCESS,
  'operations.read': OPERATIONS,
  ...AGENT_READS,
  'conversation.allowance': {
    ok: true,
    allowance: {
      set: false,
      currency: 'AUD',
      limitMinor: 5000,
      leftMinor: 3860,
      conversation: { spentMinor: 940, heldMinor: 200 },
    },
  } satisfies AllowanceResult,
  // The business's clients (C32), as the task's client field and the to-dos'
  // client scope ask them.
  'client.list': { ok: true, clients: [HARBOUR, MERIDIAN] } satisfies ClientListResult,
  // Custody's keys (C31) for Settings: one set, one not, never a value.
  'secret.list': {
    ok: true,
    canChange: true,
    secrets: [
      {
        id: 'S-1',
        name: 'xero.client-secret',
        clientId: null,
        state: 'set',
        setAt: '2026-09-30T00:00:00Z',
        lastUsedAt: null,
        revision: 1,
      },
      {
        id: 'S-2',
        name: 'ads.token',
        clientId: null,
        state: 'not set',
        setAt: null,
        lastUsedAt: null,
        revision: 2,
      },
    ],
  } satisfies SecretListResult,
  // Settings ▸ Workflow triggers (C33).
  'automation.registry': AUTOMATION_REGISTRY,
  'connection.fleet': FLEET_READ,
  'connection.signal': SIGNAL_READ,
  ...WAYFINDER_READS,
} as const satisfies Partial<Record<ReadName, unknown>>;

/** The reads the harness answers; a read missing here draws its "could not be read" state. */
export const MADE_UP_READS: readonly string[] = Object.keys(READS);

// The collections a variant can answer with no rows: the screens whose empty
// state a person meets (the board and the inbox).
const EMPTY: { readonly 'task.board': TaskBoardResult; readonly 'inbox.read': InboxReadResult } = {
  'task.board': { ok: true, tasks: [], changedAt: null, viewer: NATHAN.personId, owed: 0 },
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
// The mockup's task page (states.json, look/task.ts) draws its task with no rank
// yet; the dock panel's mockup draws the same task ranked. task.read answers by
// the key asked for, so each screen reads the task its mockup draws.
export const MOCKUP_TASK_KEY = 'proj-meridian-hero-copy';
const UNRANKED_READ = {
  ...READS['task.read'],
  task: { ...DETAIL, rank: { number: null, score: null, calc: 'not ranked: missing ease' } },
} satisfies InternalTaskRead;

export function madeUpAnswer(
  pathname: string,
  variant: MadeUpVariant = {},
  body: { readonly recordId?: unknown } = {},
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
  if (name === 'task.read' && body.recordId === MOCKUP_TASK_KEY) {
    return { status: 200, json: UNRANKED_READ };
  }
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
    const request = route.request();
    const body: unknown = request.method() === 'POST' ? request.postDataJSON() : {};
    const answer = madeUpAnswer(
      new URL(request.url()).pathname,
      variant,
      typeof body === 'object' && body !== null ? body : {},
    );
    if (answer !== undefined && 'pending' in answer) return;
    await (answer === undefined ? route.fallback() : route.fulfill(answer));
  });
}
