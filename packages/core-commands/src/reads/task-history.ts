// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's history, as `task.read` draws it: the changes applied to the
// record, oldest first. Moved out of `tasks.ts` with MP-4-8, which adds a
// duplicate's source, shown only to a viewer who holds read on the task it
// came from. U116 names the fields each change set, from its audit event.

import { checkAuthority, INTERNAL_ROLE_KEYS, isUuid } from '../../../core-records/src/index.ts';
import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import { HISTORY_FIELDS, HISTORY_OPERATIONS } from '../../../core-wire/src/index.ts';
import { invalid } from '../commands/operands.ts';
import type { FieldChanges } from '../commands/outcome.ts';
import type { CommandRefusal } from '../commands/refusal.ts';
import type { Detail } from './detail.ts';
import type { HistoryEntry, TaskDetail } from './requests.ts';
import type { RankPool } from './rank.ts';

interface HistoryRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly actor_id: string;
  readonly person_id: string | null;
  readonly command: string;
  readonly actor_kind: string | null;
  readonly actor_name: string | null;
  readonly staff: boolean;
  readonly field_changes: FieldChanges | null;
  readonly duplicated_from: string | null;
}

const OPERATIONS: readonly string[] = Object.keys(HISTORY_OPERATIONS);

/** The marks only an internal reader is sent (`scoresOf`), so only they are told one changed. */
const INTERNAL_FIELDS: ReadonlySet<string> = new Set(['impact', 'confidence', 'ease']);

// The changes only, by the closed list in `HISTORY_OPERATIONS`. Reads are
// audited (I13) and carry the record they looked at, and comments, time
// and run checks carry the task too, but a history is what *happened to*
// the task (MP-4-16: transitions only, no comments, notes or time).
//
// Who is the actor's kind and, for a person's actor, that person's name,
// joined inside this business: an actor or a person of another business
// matches nothing (MP-4-16). `staff` is the person's active membership
// here in an internal role: only then is anyone told who they are (U116).
//
// A duplicate's event carries the task it came from (MP-4-8), filtered
// below to a viewer who holds read on that task now.
const HISTORY_SQL = `select e.id, e.occurred_at, e.actor_id, a.person_id, e.command, a.kind as actor_kind,
          case when a.kind = 'person' then p.display_name end as actor_name,
          exists (select 1 from public.memberships m
                   where m.business_id = e.business_id and m.person_id = a.person_id
                     and m.active and m.role_key = any($4::text[])) as staff,
          e.field_changes, l.to_record_id::text as duplicated_from
     from public.audit_events e
     left join public.actors a on a.business_id = e.business_id and a.id = e.actor_id
     left join public.people p on p.business_id = a.business_id and p.id = a.person_id
     left join public.record_links l
       on l.business_id = e.business_id and e.command = 'task.duplicate'
      and l.link_type = 'duplicated_from' and l.from_record_id = e.subject_record_id
    where e.business_id = $1 and e.subject_record_id = $2 and e.outcome = 'applied'
      and e.command = any($3::text[])
    order by e.seq`;

/**
 * `task.read`'s `historyEventId` (U116): one entry of the task's history, by
 * its event's id. A brief or standard read carries no history to look in.
 */
export function historyEventOperand(
  body: Readonly<Record<string, unknown>>,
  detail: Detail | undefined,
): string | undefined | CommandRefusal {
  const id = body['historyEventId'];
  if (id === undefined) return undefined;
  if (typeof id !== 'string' || !isUuid(id)) {
    return invalid('historyEventId', 'Send historyEventId as the id of an entry in the history.');
  }
  if (detail === 'brief' || detail === 'standard') {
    return invalid('historyEventId', 'Ask for the full detail to look up a history entry.');
  }
  return id.toLowerCase();
}

/**
 * The changes applied to this record, in the order they happened.
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
  historyEventId?: string,
): Promise<Pick<TaskDetail, 'history' | 'historyEvent'>> {
  // The viewer whose grants decide a duplicate's source; an agent's pool is
  // its one task, and it is shown no source.
  const viewer = pool.kind === 'grants' ? pool.subjects : null;
  const rows = await tx.query<HistoryRow>(HISTORY_SQL, [
    tx.businessId,
    recordId,
    OPERATIONS,
    INTERNAL_ROLE_KEYS,
  ]);
  // A change that recorded its fields and changed none did not happen to the task.
  const changes = rows.filter((row) => row.field_changes?.keys.length !== 0);
  const history = await Promise.all(
    changes.map(async (row) => await entryOf(tx, viewer, internal, row)),
  );
  if (historyEventId === undefined) return { history };
  // Another task's event, a comment's, or one this reader is not sent are all
  // the same null: the lookup is a search of what the reader is sent.
  return {
    history,
    historyEvent: history.find((entry) => entry.eventId === historyEventId) ?? null,
  };
}

/** One row as a reader is shown it; a duplicate's source only as `shownSource` allows. */
async function entryOf(
  tx: TenantQuery,
  viewer: readonly Subject[] | null,
  internal: boolean,
  row: HistoryRow,
): Promise<HistoryEntry> {
  const shown = row.field_changes?.keys.filter(
    (key) => Object.hasOwn(HISTORY_FIELDS, key) && (internal || !INTERNAL_FIELDS.has(key)),
  );
  // A former member, a client's person, an agent or the system is not named;
  // an outside reader (and an agent, read as one) is shown no person at all.
  const named = internal && row.staff;
  const entry: HistoryEntry = {
    eventId: row.id,
    at: row.occurred_at.toISOString(),
    ...(shown === undefined || shown.length === 0 ? {} : { changed: shown }),
    actorId: row.staff ? row.actor_id : null,
    actorKind: row.actor_kind,
    personId: named ? row.person_id : null,
    actorName: named ? row.actor_name : null,
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
