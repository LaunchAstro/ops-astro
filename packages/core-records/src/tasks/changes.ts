// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 (#429): *changes since* on the live change record (migration 0057,
// CS-15.19), for API-4. The tasks stamped after a point, filtered inside the
// one query by the caller's live `task:read` grants exactly as `task.read`
// admits them: at business scope, on the task itself, or on the map the task
// is a ticket of (W12: a map is a task of type `map`, its tickets are its
// children, and a map under a map is its own, as `wayfinderFacts` reads it).
// The answer names tasks, never what changed: the caller re-reads each
// through its own checked read.
//
// A point is the oldest transaction still open when the last read ran, so a
// write open at that moment comes back next time instead of being skipped. A
// task stamped just before the point can come back twice; a duplicate costs a
// re-read. Points never go backwards: the next is at least the one given.

import type { TenantQuery } from '../tenancy/database.ts';
import { EFFECTIVE, type Subject } from '../authority/grants.ts';

/** One task that changed after the point; nothing about what changed. */
export interface TaskChange {
  readonly kind: 'task';
  readonly id: string;
  readonly changedAt: Date;
}

export interface ChangesSince {
  /** Hand this back as the next call's point. */
  readonly point: string;
  readonly changes: readonly TaskChange[];
}

// An xid8 in its canonical text, no wider than 19 digits, so any match casts.
const POINT = /^(?:0|[1-9]\d{0,18})$/u;

const CHANGES_SINCE = `${EFFECTIVE},
  readable as (
    select e.scope_kind, e.scope_id
      from effective e
     where e.collection = 'task'
       and e.action = 'read'
       and e.scope_kind in ('business', 'record')
       and exists (select 1 from unnest($1::text[], $2::uuid[]) as s (kind, id)
                    where s.kind = e.subject_kind and s.id = e.subject_id))
  select greatest(pg_snapshot_xmin(pg_current_snapshot()), $3::xid8)::text as point,
         coalesce((select json_agg(json_build_object('id', c.subject_id, 'at', c.changed_at)
                                   order by c.changed_xid, c.subject_id)
                     from public.live_changes c
                    where $3::xid8 is not null
                      and c.subject_kind = 'task'
                      and c.changed_xid >= $3::xid8
                      and (exists (select 1 from readable r where r.scope_kind = 'business')
                           or c.subject_id in (select r.scope_id from readable r
                                                where r.scope_kind = 'record')
                           or exists (select 1
                                        from public.records t
                                        join public.records p
                                          on p.business_id = t.business_id and p.id = t.uuid_4
                                         and p.record_type_id = t.record_type_id
                                       where t.business_id = c.business_id
                                         and t.id = c.subject_id
                                         and coalesce(t.data ->> 'type', '') <> 'map'
                                         and p.data ->> 'type' = 'map'
                                         and p.id in (select r.scope_id from readable r
                                                       where r.scope_kind = 'record')))),
                  '[]'::json) as changes`;

interface Row {
  readonly point: string;
  readonly changes: readonly { readonly id: string; readonly at: string }[];
}

/**
 * The tasks changed after `point` that `subjects` may read, and the next
 * point. `null` starts: the point alone. A malformed point is refused before
 * any query.
 */
export async function changesSince(
  tx: TenantQuery,
  subjects: readonly Subject[],
  point: string | null,
): Promise<ChangesSince | 'POINT_INVALID'> {
  if (point !== null && !POINT.test(point)) return 'POINT_INVALID';
  const [row] = await tx.query<Row>(CHANGES_SINCE, [
    subjects.map((subject) => subject.kind),
    subjects.map((subject) => subject.id),
    point,
  ]);
  if (row === undefined) throw new Error('changes since answered no row');
  return {
    point: row.point,
    changes: row.changes.map((change) => ({
      kind: 'task',
      id: change.id,
      changedAt: new Date(change.at),
    })),
  };
}
