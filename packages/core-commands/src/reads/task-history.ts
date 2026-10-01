// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's history, as `task.read` draws it: the applied writes against the
// record, oldest first. Moved out of `tasks.ts` with MP-4-8, which adds the
// one filtered field: a duplicate's source, shown only to a viewer who holds
// read on the task it came from.

import { checkAuthority } from '../../../core-records/src/index.ts';
import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import { READS } from '../../../core-wire/src/index.ts';
import type { HistoryEntry } from './requests.ts';
import type { RankPool } from './rank.ts';

interface HistoryRow {
  readonly occurred_at: Date;
  readonly actor_id: string;
  readonly command: string;
  readonly actor_kind: string | null;
  readonly actor_name: string | null;
  readonly duplicated_from: string | null;
}

/** The declared reads, from the surface, so a read added later is excluded by declaring it. */
const READ_COMMANDS: readonly string[] = [...READS];

/**
 * The applied attempts against this record, in the order they happened.
 *
 * Refused and replayed attempts are left out: history is what happened to the
 * task, and a refusal did not happen to it. They stay in `audit_events`, which
 * is where an operator looks and where the refusal evidence for N1 to N7 comes
 * from.
 */
export async function historyOf(
  tx: TenantQuery,
  recordId: string,
  internal: boolean,
  pool: RankPool,
): Promise<readonly HistoryEntry[]> {
  // The viewer whose grants decide a duplicate's source; an agent's pool is
  // its one task, and it is shown no source.
  const viewer = pool.kind === 'grants' ? pool.subjects : null;
  const rows = await tx.query<HistoryRow>(
    // The writes only. Reads are audited now (I13) and they carry the record
    // they looked at, which is what makes "who read this" answerable at all —
    // but a history is what *happened to* the task, and a read happened to
    // nobody. The two questions share one chain and are not the same question,
    // so the projection names the outcomes it wants rather than taking every
    // row that mentions the record.
    //
    // Who is the actor's kind and, for a person's actor, that person's name,
    // joined inside this business: an actor or a person of another business
    // matches nothing (MP-4-16).
    //
    // A duplicate's event carries the task it came from (MP-4-8), filtered
    // below to a viewer who holds read on that task now.
    `select e.occurred_at, e.actor_id, e.command, a.kind as actor_kind,
            case when a.kind = 'person' then p.display_name end as actor_name,
            l.to_record_id::text as duplicated_from
       from public.audit_events e
       left join public.actors a on a.business_id = e.business_id and a.id = e.actor_id
       left join public.people p on p.business_id = a.business_id and p.id = a.person_id
       left join public.record_links l
         on l.business_id = e.business_id and e.command = 'task.duplicate'
        and l.link_type = 'duplicated_from' and l.from_record_id = e.subject_record_id
      where e.business_id = $1 and e.subject_record_id = $2 and e.outcome = 'applied'
        and e.command <> all($3::text[])
      order by e.seq`,
    // A reader outside the business is not shown that a comment was written:
    // its comments carry only what the catalogue shares, and an internal
    // note's author and time in the history would be the note, hidden rather
    // than absent (API.md, the agent's task.read).
    [tx.businessId, recordId, internal ? READ_COMMANDS : [...READ_COMMANDS, 'task.comment']],
  );
  return await Promise.all(rows.map(async (row) => await entryOf(tx, viewer, row)));
}

/** One row as a reader is shown it; a duplicate's source only as `shownSource` allows. */
async function entryOf(
  tx: TenantQuery,
  viewer: readonly Subject[] | null,
  row: HistoryRow,
): Promise<HistoryEntry> {
  const entry: HistoryEntry = {
    at: row.occurred_at.toISOString(),
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    actorName: row.actor_name,
    operation: row.command,
  };
  if (row.command !== 'task.duplicate') return entry;
  return Object.assign(entry, {
    duplicatedFrom: await shownSource(tx, viewer, row.duplicated_from),
  });
}

/**
 * The task a duplicate came from, for a viewer who holds read on it now, by
 * the check `task.read` makes of that task; null for anyone else, an agent
 * included, who is shown that the task was duplicated and not from where.
 */
async function shownSource(
  tx: TenantQuery,
  viewer: readonly Subject[] | null,
  source: string | null,
): Promise<string | null> {
  if (viewer === null || source === null) return null;
  const reads = await checkAuthority(tx, viewer, {
    collection: 'task',
    action: 'read',
    scope: { kind: 'record', id: source },
  });
  return reads.ok ? source : null;
}
