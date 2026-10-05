// SPDX-License-Identifier: AGPL-3.0-only
//
// What a conversation's wrap-up holds (AW-03), read from records and never
// from the transcript: the work it cited or started, with each item's state
// and when it ended; the seven pointer-and-fact items; and the request, the
// first message as a marked quotation. `conversation-lifecycle.ts` writes
// them at quiet and reads the work again before a purge.

import type { ReadableScope, TenantQuery } from '../../../core-records/src/index.ts';
import type {
  ConversationPointerView,
  WrapUpItemView,
  WrapUpView,
} from '../../../core-wire/src/index.ts';
import { conversationAddress } from './conversations.ts';
import { createdTasks, type Work } from './conversation-work.ts';

const QUOTATION_LIMIT = 1_000;

/** A conversation as its row lock read it. */
export interface Locked {
  readonly owner_actor_id: string;
  readonly scope_record_id: string | null;
  readonly created_at: Date;
  readonly last_activity_at: Date;
  readonly body_purged_at: Date | null;
  readonly purge_operation_id: string | null;
  readonly quiet: boolean;
}

const pointersOf = (
  work: readonly Work[],
  kind: ConversationPointerView['kind'],
): readonly ConversationPointerView[] =>
  work.filter((item) => item.pointer.kind === kind).map((item) => item.pointer);

/** The facts worked out from their item's pointers, by item key. */
export const COUNTED_FACTS = {
  scope: (n: number): string => (n === 0 ? 'Opened with no scope' : 'Opened on a task'),
  tasks_created: (n: number) => `${String(n)} ${n === 1 ? 'task' : 'tasks'} created`,
  runs_started: (n: number) => `${String(n)} runs started`,
  gates_raised: (n: number) => `${String(n)} gates raised`,
};

const TASK_ADDRESS = /^\/task\/([^/]+)$/u;

/** Whether an address names no task, or one this reader may read. */
export type ReadsAddress = (address: string) => boolean;

/**
 * The task an address reaches, read as the web router reads it (`routes.ts`
 * `/task/:key`, `legacy.ts` `/agency/task/?task=`): path case and percent
 * escapes, trailing slashes, query and hash aside. `undefined` reaches no
 * task; `null` mentions one in a way this cannot pin down, and fails closed.
 */
function taskOfAddress(address: string): string | null | undefined {
  let url: URL;
  let path: string;
  try {
    url = new URL(address, 'http://page.invalid');
    path = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return null;
  }
  const query = url.searchParams.get('task');
  if (/^\/agency\/task\/*$/u.test(path)) return query?.toLowerCase();
  const named = /^\/task\/+([^/]+)\/*$/u.exec(path)?.[1];
  if (named !== undefined) return named;
  return query !== null || /(?:^|\/)task(?:\/|$)/u.test(path) ? null : undefined;
}

/**
 * The reader's `task:read` reach, as a check on an address: one reaching a
 * task under any spelling passes only when a business grant or a grant on
 * that task covers it, as `task.read` admits it; any other address passes.
 */
export function addressReader(tasks: ReadableScope): ReadsAddress {
  return (address) => {
    const task = taskOfAddress(address);
    return task === undefined || tasks.business || (task !== null && tasks.records.includes(task));
  };
}

/**
 * A stored wrap-up's contents as one reader may see them: a pointer to a
 * task, run or gate is kept only when its address names a task the reader may
 * read (anything else of those kinds is left out, failing closed), and a
 * counted fact counts what is left, so no id, address or count of such a task
 * reaches them (catalogue #412).
 */
function contentsForReader(stored: WrapUpRow, reads: ReadsAddress): WrapUpRow {
  const shown = (pointer: ConversationPointerView): boolean =>
    pointer.kind === 'conversation' ||
    (TASK_ADDRESS.test(pointer.address) && reads(pointer.address));
  return {
    ...stored,
    items: stored.items.map((item) => {
      const pointers = item.pointers.filter(shown);
      const count = Object.hasOwn(COUNTED_FACTS, item.key)
        ? COUNTED_FACTS[item.key as keyof typeof COUNTED_FACTS]
        : undefined;
      return { ...item, pointers, fact: count === undefined ? item.fact : count(pointers.length) };
    }),
    left_open: stored.left_open.filter(shown),
  };
}

/** A stored wrap-up version, as `conversation_wrap_ups` holds it. */
export interface WrapUpRow {
  readonly version: number;
  readonly created_at: Date;
  readonly written_by_operation: string;
  readonly code_revision: string;
  readonly definition_version: string | null;
  readonly request_quotation: string;
  readonly items: WrapUpView['items'];
  readonly left_open: WrapUpView['leftOpen'];
}

export const NOTHING_LEFT_OPEN = 'nothing left open';

export function leftOpenText(leftOpen: WrapUpView['leftOpen']): string {
  if (leftOpen.length === 0) return NOTHING_LEFT_OPEN;
  return `${String(leftOpen.length)} left open: ${leftOpen.map((pointer) => `${pointer.kind} ${pointer.id}`).join(', ')}`;
}

/** A stored wrap-up as this reader may see it (`contentsForReader`). */
export function wrapUpView(stored: WrapUpRow, reads: ReadsAddress): WrapUpView {
  const row = contentsForReader(stored, reads);
  return {
    version: stored.version,
    writtenAt: stored.created_at.toISOString(),
    writtenBy: { operation: stored.written_by_operation, codeRevision: stored.code_revision },
    definitionVersion: stored.definition_version,
    request: { quotation: stored.request_quotation },
    items: row.items,
    leftOpen: row.left_open,
    leftOpenText: leftOpenText(row.left_open),
  };
}

/** The seven pointer-and-fact contents, from records. */
export async function itemsOf(
  tx: TenantQuery,
  conversationId: string,
  locked: Pick<Locked, 'created_at' | 'last_activity_at' | 'scope_record_id'>,
  work: readonly Work[],
): Promise<readonly WrapUpItemView[]> {
  const counts = await tx.query<{ n: string; first: Date; last: Date }>(
    `select count(*)::text as n, min(created_at) as first, max(created_at) as last
       from conversation_messages where business_id = $1 and conversation_id = $2`,
    [tx.businessId, conversationId],
  );
  const exchange = counts[0];
  const created = await createdTasks(tx, conversationId);
  const self: ConversationPointerView = {
    kind: 'conversation',
    id: conversationId,
    address: conversationAddress(conversationId),
  };
  const tasks = pointersOf(work, 'task').filter((pointer) => pointer.id === locked.scope_record_id);
  const runs = pointersOf(work, 'run');
  const gates = pointersOf(work, 'gate');
  return [
    {
      key: 'opened',
      fact: `Opened ${locked.created_at.toISOString()} by its owner`,
      pointers: [self],
    },
    {
      key: 'scope',
      fact: COUNTED_FACTS.scope(tasks.length),
      pointers: tasks,
    },
    {
      key: 'exchange',
      fact: `${exchange?.n ?? '0'} messages, last ${locked.last_activity_at.toISOString()}`,
      pointers: [],
    },
    // Each task whose creation audit event names this conversation (AW-03).
    {
      key: 'tasks_created',
      fact: COUNTED_FACTS.tasks_created(created.length),
      pointers: created,
    },
    { key: 'runs_started', fact: COUNTED_FACTS.runs_started(runs.length), pointers: runs },
    { key: 'gates_raised', fact: COUNTED_FACTS.gates_raised(gates.length), pointers: gates },
    // Priced model calls go through AW-01's broker; the conversation's own
    // calls are counted here once the exchange makes them.
    { key: 'cost', fact: 'No priced model call recorded', pointers: [] },
  ];
}

export async function requestQuotation(tx: TenantQuery, conversationId: string): Promise<string> {
  const rows = await tx.query<{ body: string }>(
    `select body from conversation_messages
      where business_id = $1 and conversation_id = $2 and role = 'person'
      order by created_at, id limit 1`,
    [tx.businessId, conversationId],
  );
  const body = rows[0]?.body ?? '';
  return body.length <= QUOTATION_LIMIT ? body : `${body.slice(0, QUOTATION_LIMIT - 1)}…`;
}
