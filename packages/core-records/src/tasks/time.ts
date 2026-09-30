// SPDX-License-Identifier: AGPL-3.0-only
//
// The time entry store (MP-4-6, CS-4.1, CS-4.28 to CS-4.31; migration 0047).
//
// A time entry is a stretch of one person's time on one task: running while
// it has no end, finished once it has whole minutes. Every statement here is
// filtered by the business the session set, on top of the table's forced row
// security, and the task is looked up live in this business before an entry
// is written against it, so an identifier from another business is a task
// that is not here.
//
// **One running timer per person** is the database's rule: the start inserts
// `on conflict do nothing` against the partial unique index, so two starts at
// once leave one row and the other start is told a timer is running.
//
// **Elapsed time is never dropped.** A stop logs the elapsed minutes rounded
// up, and never fewer than one; a running entry is stopped before it can be
// deleted. Notes and deletes reach only the person's own entries: another
// person's entry is `absent`, the same answer as one that does not exist.
//
// **A new entry takes its task's Ad hoc mark** (MP-4-10, `bool_2`), read in the
// insert itself, so an entry cannot start from a different answer than the
// task page shows.
//
// Who may do any of this is the commands' question (`time:write`); this store
// is told the person and trusts it.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { isUuid } from '../tenancy/ids.ts';

export interface TimeEntry {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly minutes: number | null;
  readonly note: string;
  readonly adHoc: boolean;
  readonly source: 'timer' | 'log';
}

export interface TaskTime {
  /** The reader's own live entries, newest first. */
  readonly entries: readonly TimeEntry[];
  /** The reader's own running timer on this task, or null. */
  readonly running: { readonly entryId: string; readonly startedAt: string } | null;
  /** Every person's finished minutes on the task, summed: one number, no names. */
  readonly totalMinutes: number;
}

interface Person {
  readonly personId: string;
  readonly actorId: string;
}

/** A day is the most one entry can hold (0047's check). */
const MAX_MINUTES = 1440;

/**
 * Minutes from what a person types: "1h 30m", "1h30m", "2h", "90m" or "90".
 * Anything else, zero, or more than a day is undefined, never a guess.
 */
export function parseDuration(text: string): number | undefined {
  const match = /^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m?)?\s*$/u.exec(text);
  if (match === null) return undefined;
  const [, hours, rest] = match;
  if (hours === undefined && rest === undefined) return undefined;
  // "1h 70" is not a length of time anybody means.
  if (hours !== undefined && rest !== undefined && Number(rest) >= 60) return undefined;
  const minutes = Number(hours ?? 0) * 60 + Number(rest ?? 0);
  return minutes >= 1 && minutes <= MAX_MINUTES ? minutes : undefined;
}

/** The live task's Ad hoc mark, or undefined when no live task of this business has the id. */
async function taskAdHoc(tx: TenantQuery, taskId: string): Promise<boolean | undefined> {
  // Never cast what is not an identifier: it names no task, like a foreign one.
  if (!isUuid(taskId)) return undefined;
  const rows = await tx.query<{ readonly ad_hoc: boolean | null }>(
    `select r.bool_2 as ad_hoc from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where r.business_id = $1 and r.id = $2::uuid and r.deleted_at is null and t.key = 'task'`,
    [tx.businessId, taskId],
  );
  const row = rows[0];
  return row === undefined ? undefined : row.ad_hoc === true;
}

export async function startTimer(
  tx: TenantQuery,
  input: Person & { readonly taskId: string },
): Promise<
  | { readonly kind: 'started'; readonly entryId: string; readonly startedAt: string }
  | { readonly kind: 'running' }
  | { readonly kind: 'no-task' }
> {
  const adHoc = await taskAdHoc(tx, input.taskId);
  if (adHoc === undefined) return { kind: 'no-task' };
  const rows = await tx.query<{ readonly id: string; readonly started_at: Date }>(
    `insert into public.time_entries
       (business_id, id, task_id, person_id, actor_id, started_at, ad_hoc, source)
     values ($1, $2, $3, $4, $5, now(), $6, 'timer')
     on conflict (business_id, person_id) where ended_at is null and deleted_at is null
     do nothing
     returning id, started_at`,
    [tx.businessId, randomUUID(), input.taskId, input.personId, input.actorId, adHoc],
  );
  const row = rows[0];
  if (row === undefined) return { kind: 'running' };
  return { kind: 'started', entryId: row.id, startedAt: row.started_at.toISOString() };
}

/** Stop this person's running timer on this task, logging its minutes. */
export async function stopTimer(
  tx: TenantQuery,
  input: Person & { readonly taskId: string },
): Promise<
  | { readonly kind: 'stopped'; readonly entryId: string; readonly minutes: number }
  | { readonly kind: 'none' }
> {
  if (!isUuid(input.taskId)) return { kind: 'none' };
  const rows = await tx.query<{ readonly id: string; readonly minutes: number }>(
    `update public.time_entries
        set ended_at = now(),
            minutes = least($4::int,
                            greatest(1, ceil(extract(epoch from now() - started_at) / 60)::int))
      where business_id = $1 and task_id = $2::uuid and person_id = $3
        and ended_at is null and deleted_at is null
      returning id, minutes`,
    [tx.businessId, input.taskId, input.personId, MAX_MINUTES],
  );
  const row = rows[0];
  return row === undefined
    ? { kind: 'none' }
    : { kind: 'stopped', entryId: row.id, minutes: row.minutes };
}

/** A finished entry logged by hand, ending now. */
export async function logTime(
  tx: TenantQuery,
  input: Person & { readonly taskId: string; readonly minutes: number; readonly note: string },
): Promise<{ readonly kind: 'logged'; readonly entryId: string } | { readonly kind: 'no-task' }> {
  const adHoc = await taskAdHoc(tx, input.taskId);
  if (adHoc === undefined) return { kind: 'no-task' };
  const id = randomUUID();
  await tx.query(
    `insert into public.time_entries
       (business_id, id, task_id, person_id, actor_id, started_at, ended_at, minutes, note,
        ad_hoc, source)
     values ($1, $2, $3, $4, $5, now() - make_interval(mins => $6), now(), $6, $7, $8, 'log')`,
    [
      tx.businessId,
      id,
      input.taskId,
      input.personId,
      input.actorId,
      input.minutes,
      input.note,
      adHoc,
    ],
  );
  return { kind: 'logged', entryId: id };
}

/** Change the note on the person's own live entry; false when there is none. */
export async function setTimeEntryNote(
  tx: TenantQuery,
  input: Person & { readonly entryId: string; readonly note: string },
): Promise<boolean> {
  if (!isUuid(input.entryId)) return false;
  const rows = await tx.query<{ readonly id: string }>(
    `update public.time_entries set note = $4
      where business_id = $1 and id = $2::uuid and person_id = $3 and deleted_at is null
      returning id`,
    [tx.businessId, input.entryId, input.personId, input.note],
  );
  return rows.length > 0;
}

/** Mark the person's own finished entry deleted. A running one is stopped first. */
export async function deleteTimeEntry(
  tx: TenantQuery,
  input: Person & { readonly entryId: string },
): Promise<'deleted' | 'running' | 'absent'> {
  if (!isUuid(input.entryId)) return 'absent';
  const rows = await tx.query<{ readonly running: boolean }>(
    `select ended_at is null as running from public.time_entries
      where business_id = $1 and id = $2::uuid and person_id = $3 and deleted_at is null
      for update`,
    [tx.businessId, input.entryId, input.personId],
  );
  const row = rows[0];
  if (row === undefined) return 'absent';
  if (row.running) return 'running';
  await tx.query(
    `update public.time_entries set deleted_at = now() where business_id = $1 and id = $2::uuid`,
    [tx.businessId, input.entryId],
  );
  return 'deleted';
}

interface EntryRow {
  readonly id: string;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly minutes: number | null;
  readonly note: string;
  readonly ad_hoc: boolean;
  readonly source: 'timer' | 'log';
}

/**
 * A task's time as one person reads it: their own live entries and running
 * timer, and the task's total (RS-VAULT-9: a person sees their own time,
 * never a leaderboard). Another person's entries never leave the database;
 * the total is a sum with no rows behind it.
 */
export async function readTaskTime(
  tx: TenantQuery,
  taskId: string,
  readerPersonId: string,
): Promise<TaskTime> {
  if (!isUuid(taskId)) return { entries: [], running: null, totalMinutes: 0 };
  const rows = await tx.query<EntryRow>(
    `select e.id, e.started_at, e.ended_at, e.minutes, e.note, e.ad_hoc, e.source
       from public.time_entries e
      where e.business_id = $1 and e.task_id = $2::uuid and e.person_id = $3
        and e.deleted_at is null
      order by e.started_at desc, e.id`,
    [tx.businessId, taskId, readerPersonId],
  );
  const total = await tx.query<{ readonly minutes: number }>(
    `select coalesce(sum(minutes), 0)::int as minutes from public.time_entries
      where business_id = $1 and task_id = $2::uuid and deleted_at is null`,
    [tx.businessId, taskId],
  );
  const entries = rows.map((row): TimeEntry => ({
    id: row.id,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    minutes: row.minutes,
    note: row.note,
    adHoc: row.ad_hoc,
    source: row.source,
  }));
  const mine = entries.find((entry) => entry.endedAt === null);
  return {
    entries,
    running: mine === undefined ? null : { entryId: mine.id, startedAt: mine.startedAt },
    totalMinutes: total[0]?.minutes ?? 0,
  };
}
