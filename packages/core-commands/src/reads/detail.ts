// SPDX-License-Identifier: AGPL-3.0-only
//
// Detail levels and pages for the task reads (API-3, CS-15.19). Every read
// the agent CLI makes names a level: `brief` (ids, names, state), `standard`
// (what most work needs, the CLI's default) or `full` (everything, the whole
// thread and history included). A read that names none answers `full`, as it
// did before levels existed, so the app's callers are unchanged. A level is a
// projection of what the caller may already read, never a wider read.

import { createHash } from 'node:crypto';
import type { SharedTaskView, TaskDetail, TaskSummary } from '../../../core-wire/src/index.ts';
import {
  checkAuthority,
  pageSizes,
  readableScope,
  subjectsOf,
  wayfinderFacts,
} from '../../../core-records/src/index.ts';
import type { Session, Subject, TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';

export type Detail = 'brief' | 'standard' | 'full';
const DETAILS: ReadonlySet<string> = new Set(['brief', 'standard', 'full']);

/** How many of the latest comments a standard read carries; `full` carries them all. */
export const RECENT_COMMENTS = 5;

export interface Paging {
  readonly detail?: Detail;
  readonly limit?: number;
  readonly page?: string;
}

const invalid = (field: string, fix: string): CommandRefusal =>
  refuseCommand('FIELD_VALUE_INVALID', [field], [fix]);

/** The level, page size and page token a body asks for, each checked; absent ones stay absent. */
export function parsePaging(body: Readonly<Record<string, unknown>>): Paging | CommandRefusal {
  const { detail, limit, page } = body;
  // The quota table this request is served under (`identity/quota.ts`), the one place they are set.
  const { most } = pageSizes();
  if (detail !== undefined && (typeof detail !== 'string' || !DETAILS.has(detail))) {
    return invalid('detail', 'Send detail as brief, standard or full.');
  }
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > most)
  ) {
    return invalid('limit', `Send limit as a whole number from 1 to ${String(most)}.`);
  }
  if (page !== undefined && (typeof page !== 'string' || page === '')) {
    return invalid('page', 'Send page as the next token a previous page returned.');
  }
  return {
    ...(detail === undefined ? {} : { detail: detail as Detail }),
    ...(limit === undefined ? {} : { limit: limit as number }),
    ...(page === undefined ? {} : { page: page as string }),
  };
}

export function isRefusal(value: Paging | CommandRefusal): value is CommandRefusal {
  return 'refused' in value;
}

/** A task's blockers as a reader is shown them: the ones it may read, and how many it may not. */
export interface Blockers {
  readonly blockedBy: readonly string[];
  readonly withheld: number;
}

/**
 * May these subjects read this task? The read pipeline's own question
 * (`reads/dispatch.ts`): read on the task at its record scope, or at the scope
 * of the map it is a ticket of (W12); a business-wide grant answers both.
 */
async function mayRead(
  tx: TenantQuery,
  subjects: readonly Subject[],
  id: string,
): Promise<boolean> {
  const asked = { collection: 'task', action: 'read', scope: { kind: 'record', id } } as const;
  if ((await checkAuthority(tx, subjects, asked)).ok) return true;
  const map = (await wayfinderFacts(tx, id))?.mapId ?? null;
  if (map === null || map === id) return false;
  return (await checkAuthority(tx, subjects, { ...asked, scope: { kind: 'record', id: map } })).ok;
}

/**
 * The blockers `subjects` may read, and a count of the rest, which are left
 * out and named as withheld, never listed by id (standing gate 9). No subjects
 * (an agent, whose delegation reaches only its own task) withholds them all.
 */
export async function blockersFor(
  tx: TenantQuery,
  subjects: readonly Subject[],
  recordId: string,
): Promise<Blockers> {
  const all = await blockersOf(tx, recordId);
  const shown: string[] = [];
  for (const id of all) {
    // eslint-disable-next-line no-await-in-loop -- one grant check per blocker, on one transaction
    if (subjects.length > 0 && (await mayRead(tx, subjects, id))) shown.push(id);
  }
  return { blockedBy: shown, withheld: all.length - shown.length };
}

/**
 * The blockers a leveled `task.read` shows its caller. An agent credential
 * reads the agent view (catalogue #418), as the agent prefix does: every
 * blocker withheld, by count. A member reading through record grants is a
 * client login under owner answer 22 and is told no count of what it may not
 * read, as `task.board` tells it none (SL07-B22-ANSWER).
 */
export async function readerBlockers(
  tx: TenantQuery,
  session: Session,
  recordId: string,
): Promise<Blockers> {
  if (session.credentialScope !== undefined) return await blockersFor(tx, [], recordId);
  const subjects = subjectsOf(session);
  const { blockedBy, withheld } = await blockersFor(tx, subjects, recordId);
  const { business } = await readableScope(tx, subjects, 'task', 'read');
  return { blockedBy, withheld: business ? withheld : 0 };
}

/**
 * Every live task this one is blocked by, oldest link first; a link from a
 * record of another type is not a blocker. Never answered as is.
 */
async function blockersOf(tx: TenantQuery, recordId: string): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly id: string }>(
    `select l.from_record_id::text as id from public.record_links l
       join public.records r on r.business_id = l.business_id and r.id = l.from_record_id
      join public.records t on t.business_id = l.business_id and t.id = l.to_record_id
      where l.business_id = $1 and l.to_record_id = $2 and l.link_type = 'blocks'
        and r.record_type_id = t.record_type_id and r.deleted_at is null
      order by l.id`,
    [tx.businessId, recordId],
  );
  return rows.map((row) => row.id);
}

/** Ids, name and state: all a brief read carries. */
export function briefOf(task: TaskSummary): Readonly<Record<string, unknown>> {
  return { id: task.id, title: task.title, state: task.state?.label ?? null };
}

/** The whole summary: all a full list read carries. */
const fullOf = (task: TaskSummary): Readonly<Record<string, unknown>> => ({ ...task });

/** The summary with its state and assignee as the words a reader uses. */
export function standardSummaryOf(task: TaskSummary): Readonly<Record<string, unknown>> {
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    state: task.state?.label ?? null,
    assignee: task.assignee?.name ?? null,
    due: task.due,
    priority: task.priority,
    completedAt: task.completedAt,
    revision: task.revision,
  };
}

/** One task at the level asked for. `full` is the detail itself, with its blockers. */
export function taskAt(
  detail: Detail,
  task: TaskDetail,
  blockers: Blockers,
): Readonly<Record<string, unknown>> {
  if (detail === 'brief') return briefOf(task);
  const { blockedBy, withheld } = blockers;
  const named = withheld === 0 ? { blockedBy } : { blockedBy, blockersWithheld: withheld };
  if (detail === 'full') return { ...task, ...named };
  return {
    ...standardSummaryOf(task),
    description: task.description,
    ...named,
    comments: task.comments.slice(-RECENT_COMMENTS),
    commentCount: task.comments.length,
  };
}

/**
 * The shared view (`readSharedTask`) at a level, for a reader outside the
 * business: projected from the shared fields and client comments it already
 * carries, never from the detail. `brief` is its id, title and state.
 */
function sharedAt(detail: Detail, shared: SharedTaskView): Readonly<Record<string, unknown>> {
  const { fields, comments } = shared;
  if (detail === 'brief') {
    return { id: shared.id, title: fields['title'] ?? null, state: fields['state'] ?? null };
  }
  if (detail === 'full') return { ...shared };
  return { ...shared, comments: comments.slice(-RECENT_COMMENTS), commentCount: comments.length };
}

/** An external party's `task.read`: the shared view, or at a level its projection. */
export function sharedRead(
  detail: Detail | undefined,
  sharedTask: SharedTaskView,
):
  | { readonly ok: true; readonly sharedTask: SharedTaskView }
  | {
      readonly ok: true;
      readonly detail: Detail;
      readonly view: Readonly<Record<string, unknown>>;
    } {
  if (detail === undefined) return { ok: true, sharedTask };
  return { ok: true, detail, view: sharedAt(detail, sharedTask) };
}

const digestOf = (tasks: readonly TaskSummary[]): string =>
  createHash('sha256')
    .update(tasks.map((task) => task.id).join(','))
    .digest('hex');
const tokenOf = (shown: readonly TaskSummary[]): string =>
  `${String(shown.length)}.${digestOf(shown)}`;

const DIGITS: ReadonlySet<string> = new Set('0123456789');
const HEX: ReadonlySet<string> = new Set('0123456789abcdef');
const only = (text: string, allowed: ReadonlySet<string>): boolean =>
  [...text].every((char) => allowed.has(char));

/**
 * A page token read by its one grammar, `<count>.<digest>`: how many tasks the
 * pages so far showed (a whole number from 1, no leading zero) and the sha-256
 * of their ids in order (64 lowercase hex). Anything else is no token.
 */
function shownBy(token: string): { readonly count: number; readonly digest: string } | undefined {
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [count = '', digest = ''] = parts;
  if (count === '' || count.length > 9 || !only(count, DIGITS) || count.startsWith('0')) {
    return undefined;
  }
  if (digest.length !== 64 || !only(digest, HEX)) return undefined;
  return { count: Number(count), digest };
}

/**
 * One page of a list in its order. The token names the tasks the pages so far
 * showed, by count and digest, and the next page is served only while the list
 * still starts with exactly those tasks in that order: none shows twice and
 * none is left out, and a task added after them joins a later page. A list
 * reordered, or a task shown since removed, refuses the token, as does one
 * that names no list; it is never read as the first page.
 */
export function pageOf(
  tasks: readonly TaskSummary[],
  paging: Paging,
):
  | { readonly items: readonly Readonly<Record<string, unknown>>[]; readonly next: string | null }
  | CommandRefusal {
  let start = 0;
  if (paging.page !== undefined) {
    const before = shownBy(paging.page);
    if (
      before === undefined ||
      before.count > tasks.length ||
      digestOf(tasks.slice(0, before.count)) !== before.digest
    ) {
      return invalid('page', 'That page token is spent; list again from the start.');
    }
    start = before.count;
  }
  const size = paging.limit ?? pageSizes().standard;
  const end = Math.min(start + size, tasks.length);
  const shown = tasks.slice(start, end);
  const level = paging.detail ?? 'full';
  const items = shown.map((task): Readonly<Record<string, unknown>> => {
    if (level === 'brief') return briefOf(task);
    return level === 'standard' ? standardSummaryOf(task) : fullOf(task);
  });
  return { items, next: end < tasks.length ? tokenOf(tasks.slice(0, end)) : null };
}
