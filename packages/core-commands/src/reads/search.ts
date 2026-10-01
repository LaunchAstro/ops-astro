// SPDX-License-Identifier: AGPL-3.0-only
//
// Search: the one scoped query service over the lexical index (ticket C1).
//
// **Scope before candidates.** The viewer's live `read` scopes are a predicate
// of the statement that finds candidates, never a filter over what it found.
// A post-filter reads the other client's row into this process and throws it
// away, which is reading it; and a count taken before the filter is the leak
// SP-8 names. So the grants are asked first (`heldScopes`, the grant model's
// own expression of "live") and the statement is handed the answer: the whole
// business, or the named records and nothing else.
//
// `search_tsv` is kept by the record store's trigger from searchable slotted
// text (`migrations/0005_record_store.sql`), which for a task is its title.
// The ledger, the Docs panel and C84's erasure canary call this function
// rather than a second query over the same index.

import { heldScopes, subjectsOf } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import type { SearchHit, TaskSearchResult } from '../../../core-wire/src/index.ts';

/** The most hits one search answers; the ⌘K list shows a handful. */
const HIT_LIMIT = 20;
/**
 * The most a server caller may ask for; the ledger's search (MP-8-4) asks for
 * all of it. The `task.search` read passes no limit, so it stays at twenty.
 */
export const SERVER_HIT_LIMIT = 500;
/** The words of a query that reach the index; the rest are dropped. */
const WORD_LIMIT = 8;

/**
 * The words of a query, letters and digits only. Nothing else reaches
 * `to_tsquery`, so its operators cannot be spelled by the caller; the value is
 * bound as a parameter besides.
 */
export function wordsOf(query: string): readonly string[] {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, WORD_LIMIT);
}

interface HitRow {
  readonly id: string;
  readonly key: string | null;
  readonly title: string | null;
}

/**
 * The tasks matching every word of `query`, each word as a prefix, among the
 * tasks the viewer may read. A viewer who may read none is refused, never
 * answered with an empty list; an empty list means nothing in scope matched.
 *
 * A session with no membership is refused too: the portal has no search until
 * a client search is designed (ticket C1), and a searchable field the share
 * does not show would otherwise be found by a word it never displays.
 *
 * A server caller may pass `limit` (1 to 500), checked before anything is
 * read. The answer then says whether more of the caller's own matches lie
 * past it: one row more is asked of the same scoped statement, so `more`
 * counts nothing the caller may not read.
 */
export async function searchTasks(
  tx: TenantQuery,
  session: Session,
  target: { readonly taskTypeId: string; readonly query: string; readonly limit?: number },
): Promise<TaskSearchResult | CommandRefusal> {
  const asked = target.limit === undefined ? HIT_LIMIT : target.limit;
  if (!Number.isInteger(asked) || asked < 1 || asked > SERVER_HIT_LIMIT) return LIMIT_INVALID;
  if (session.roleKey === null) return NOT_A_MEMBER;
  const wanted = target.limit === undefined ? asked : asked + 1;
  const scopes = await heldScopes(tx, subjectsOf(session), { collection: 'task', action: 'read' });
  if (scopes.length === 0) return NO_READ_GRANT;
  const wholeBusiness = scopes.some((scope) => scope.kind === 'business');
  const records = scopes.flatMap((scope) => (scope.kind === 'record' ? [scope.id] : []));
  const words = wordsOf(target.query).map((word) => `${word}:*`);

  // Key `txt_1` and title `txt_4`, the slots `reads/tasks.ts` reads.
  const rows = await tx.query<HitRow>(
    `select r.id, r.txt_1 as key, r.txt_4 as title
       from public.records r
      where r.business_id = $1
        and r.record_type_id = $2
        and r.deleted_at is null
        and ($3::boolean or r.id = any($4::uuid[]))
        and r.search_tsv @@ to_tsquery('english', $5)
      order by ts_rank(r.search_tsv, to_tsquery('english', $5)) desc, r.txt_1
      limit $6::int`,
    [tx.businessId, target.taskTypeId, wholeBusiness, records, words.join(' & '), wanted],
  );
  const hits = rows.slice(0, asked).map((row) => hitOf(row));
  return target.limit === undefined
    ? { ok: true, hits }
    : { ok: true, hits, more: rows.length > asked };
}

function hitOf(row: HitRow): SearchHit {
  return { id: row.id, key: row.key ?? '', title: row.title };
}

const NO_READ_GRANT = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);

const LIMIT_INVALID = refuseCommand(
  'FIELD_VALUE_INVALID',
  ['limit'],
  [`send limit as a whole number from 1 to ${String(SERVER_HIT_LIMIT)}`],
);

const NOT_A_MEMBER = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['search is for members of the business', 'open the shared task from its link'],
);
