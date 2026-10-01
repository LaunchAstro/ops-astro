// SPDX-License-Identifier: AGPL-3.0-only
//
// The activity ledger (MP-8-4, CS-8.9): what happened to the business's
// tasks, by day in the reader's zone, a page of whole days at a time (R49).
//
// It is a view over `audit_events` and nothing else. The ledger is the same
// rows a task's history reads (`historyOf` in `reads/tasks.ts`), taken across
// every live task rather than one: applied writes only, because a read and a
// refusal happened to nobody. It is staff's: a reader who is not internal is
// shown a task's shared view, which carries no history, so the catalogue row
// answers them `NOT_FOUND` before this runs.
//
// One statement, so the page's days and their events come from one snapshot:
// two statements could see a write land between them on a day the first never
// counted.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { LedgerDayView, LedgerEventView } from '../../../core-wire/src/index.ts';
import { READS } from '../../../core-wire/src/index.ts';

/** Days to a page (R49: "Load earlier days" pages by whole days). */
export const LEDGER_DAYS_PER_PAGE = 7;

/** Reads and the lease heartbeat: neither changed a task. */
const NOT_A_CHANGE: readonly string[] = [...READS, 'task.heartbeat'];

/** What an actor with no person of its own is called in the ledger. */
const ACTOR_KIND_NAME: Readonly<Record<string, string>> = {
  agent: 'An agent',
  worker: 'A worker',
};

interface LedgerRow {
  readonly id: string;
  readonly day: string;
  readonly occurred_at: Date;
  readonly command: string;
  readonly actor_kind: string;
  readonly actor_name: string | null;
  readonly task_key: string | null;
  readonly task_title: string | null;
  readonly days_found: number;
}

export interface LedgerPage {
  readonly days: readonly LedgerDayView[];
  readonly earlier: boolean;
}

/**
 * The page's query: the applied writes to live tasks (only those in `$8` when
 * it is not null), the newest days with any before `$5` (all of them when it
 * is null) in the zone `$3`, and how many days were found, so one day past the
 * page says whether there are earlier ones.
 */
const LEDGER_PAGE = `with changes as (
     select e.id, e.seq, e.occurred_at, e.command, e.actor_id,
            r.txt_1 as task_key, r.txt_4 as task_title,
            (e.occurred_at at time zone $3::text)::date as day
       from public.audit_events e
       join public.records r
         on r.business_id = e.business_id and r.id = e.subject_record_id
      where e.business_id = $1
        and r.business_id = $1
        and r.record_type_id = $2
        and r.deleted_at is null
        and e.outcome = 'applied'
        and e.command <> all($4::text[])
        and ($5::date is null
             or e.occurred_at < ($5::date)::timestamp at time zone $3::text)
        and ($8::uuid[] is null or r.id = any($8::uuid[]))
   ),
   found as (
     select distinct day from changes order by day desc limit $6
   ),
   shown as (
     select day from found order by day desc limit $7
   )
   select c.id, to_char(c.day, 'YYYY-MM-DD') as day, c.occurred_at, c.command,
          a.kind as actor_kind, p.display_name as actor_name, c.task_key, c.task_title,
          (select count(*) from found)::int as days_found
     from changes c
     join shown s on s.day = c.day
     join public.actors a on a.business_id = $1 and a.id = c.actor_id
     left join public.people p on p.business_id = $1 and p.id = a.person_id
    order by c.occurred_at desc, c.seq desc`;

/** Rows, newest first, as whole days, each day's events newest first. */
function groupByDay(rows: readonly LedgerRow[]): LedgerPage['days'] {
  const days: { day: string; events: LedgerEventView[] }[] = [];
  for (const row of rows) {
    const event: LedgerEventView = {
      id: row.id,
      at: row.occurred_at.toISOString(),
      actorName: row.actor_name ?? ACTOR_KIND_NAME[row.actor_kind] ?? 'Someone',
      operation: row.command,
      task: { key: row.task_key ?? '', title: row.task_title },
    };
    const last = days.at(-1);
    if (last?.day === row.day) last.events.push(event);
    else days.push({ day: row.day, events: [event] });
  }
  return days;
}

/**
 * One page of the ledger: the newest days with events before `before` (all
 * of them when it is null), and whether any day before those has one. With
 * `taskIds`, only those tasks' events: a search's answer, never widened.
 *
 * `timeZone` has been checked against the server's zone names by the caller;
 * it is still only ever a bound parameter.
 */
export async function readLedger(
  tx: TenantQuery,
  taskTypeId: string,
  page: {
    readonly before: string | null;
    readonly timeZone: string;
    /** The tasks a search found; null for every task. */
    readonly taskIds: readonly string[] | null;
  },
): Promise<LedgerPage> {
  const rows = await tx.query<LedgerRow>(LEDGER_PAGE, [
    tx.businessId,
    taskTypeId,
    page.timeZone,
    NOT_A_CHANGE,
    page.before,
    LEDGER_DAYS_PER_PAGE + 1,
    LEDGER_DAYS_PER_PAGE,
    page.taskIds,
  ]);
  return { days: groupByDay(rows), earlier: (rows[0]?.days_found ?? 0) > LEDGER_DAYS_PER_PAGE };
}

/** Whether the server knows `name` as a time zone, exactly as spelled. */
export async function isKnownTimeZone(tx: TenantQuery, name: string): Promise<boolean> {
  const rows = await tx.query<{ readonly known: boolean }>(
    'select exists (select 1 from pg_timezone_names where name = $1) as known',
    [name],
  );
  return rows[0]?.known === true;
}
