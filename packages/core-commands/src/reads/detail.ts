// SPDX-License-Identifier: AGPL-3.0-only
//
// Detail levels and pages for the task reads (API-3, CS-15.19). Every read
// the agent CLI makes names a level: `brief` (ids, names, state), `standard`
// (what most work needs, the CLI's default) or `full` (everything, the whole
// thread and history included). A read that names none answers `full`, as it
// did before levels existed, so the app's callers are unchanged. A level is a
// projection of what the caller may already read, never a wider read.

import type { TaskDetail, TaskSummary } from '../../../core-wire/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';

export type Detail = 'brief' | 'standard' | 'full';
const DETAILS: ReadonlySet<string> = new Set(['brief', 'standard', 'full']);

/** How many of the latest comments a standard read carries; `full` carries them all. */
export const RECENT_COMMENTS = 5;

/** Page sizes for a list read: the default, and the most one page may ask for. */
export const PAGE_SIZE = { standard: 20, most: 100 } as const;

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
  if (detail !== undefined && (typeof detail !== 'string' || !DETAILS.has(detail))) {
    return invalid('detail', 'Send detail as brief, standard or full.');
  }
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE.most)
  ) {
    return invalid('limit', `Send limit as a whole number from 1 to ${String(PAGE_SIZE.most)}.`);
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

/** The tasks this one is blocked by, oldest link first. */
export async function blockersOf(tx: TenantQuery, recordId: string): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly id: string }>(
    `select l.from_record_id::text as id from public.record_links l
       join public.records r on r.business_id = l.business_id and r.id = l.from_record_id
      where l.business_id = $1 and l.to_record_id = $2 and l.link_type = 'blocks'
        and r.deleted_at is null
      order by l.id`,
    [tx.businessId, recordId],
  );
  return rows.map((row) => row.id);
}

/** Ids, name and state: all a brief read carries. */
export function briefOf(task: TaskSummary): Readonly<Record<string, unknown>> {
  return { id: task.id, title: task.title, state: task.state?.label ?? null };
}

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
  blockedBy: readonly string[],
): Readonly<Record<string, unknown>> {
  if (detail === 'brief') return briefOf(task);
  if (detail === 'full') return { ...task, blockedBy };
  return {
    ...standardSummaryOf(task),
    description: task.description,
    blockedBy,
    comments: task.comments.slice(-RECENT_COMMENTS),
    commentCount: task.comments.length,
  };
}

const tokenOf = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');
const idOfToken = (token: string): string => Buffer.from(token, 'base64url').toString('utf8');

/**
 * One page of a list in its stable order. The token names the last task the
 * page showed, so a task added meanwhile joins a later page and none shows
 * twice. A token that names no task on the list is refused, never read as the
 * first page.
 */
export function pageOf(
  tasks: readonly TaskSummary[],
  paging: Paging,
):
  | { readonly items: readonly Readonly<Record<string, unknown>>[]; readonly next: string | null }
  | CommandRefusal {
  let start = 0;
  if (paging.page !== undefined) {
    const after = idOfToken(paging.page);
    const at = tasks.findIndex((task) => task.id === after);
    if (at < 0) return invalid('page', 'That page token is spent; list again from the start.');
    start = at + 1;
  }
  const size = paging.limit ?? PAGE_SIZE.standard;
  const shown = tasks.slice(start, start + size);
  const level = paging.detail ?? 'full';
  const items = shown.map((task): Readonly<Record<string, unknown>> => {
    if (level === 'brief') return briefOf(task);
    return level === 'standard' ? standardSummaryOf(task) : { ...task };
  });
  const last = shown.at(-1);
  return {
    items,
    next: start + size < tasks.length && last !== undefined ? tokenOf(last.id) : null,
  };
}
