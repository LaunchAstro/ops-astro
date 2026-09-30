// SPDX-License-Identifier: AGPL-3.0-only
//
// What each run on a task was allowed to touch (MP-6-4, CS-6.1): the scope
// stamp's facts, read beside the proposals in their one snapshot.
//
// **The scope is the lease's delegation, never the task's fields.** The broker
// sets `leases.delegation_id` when the agent picks the work up (R71: an
// explicit link, so the stamp names the grant), and the delegation carries the
// purpose, the one resource it was minted for, and the collections and actions
// it may use. Nothing a person edits on the task is read here, so relabelling
// the task cannot widen or even redraw what the run was allowed (R76).
//
// **The grants shown are the ones the delegation draws on now.** A delegation
// is narrower than its person by construction: every call it makes intersects
// with the delegating person's live grants (`checkDelegatedAuthority`). So the
// ledger link names those grants, as the grant model judges them live, and only
// the ones that reach this task: a business-wide grant, or a grant on this
// task's record. A grant the person holds on another task is never read into
// this answer, so the stamp names no other client's record.

import { EFFECTIVE_GRANTS } from '../../../core-records/src/index.ts';
import type { RunScopeView } from '../../../core-wire/src/index.ts';

export interface ScopeRow {
  readonly lineage_id: string;
  readonly lease_id: string;
  readonly acquired_at: string;
  readonly delegation_id: string | null;
  readonly purpose: string | null;
  readonly purpose_scope_kind: string | null;
  readonly purpose_scope_id: string | null;
  readonly collections: readonly string[] | null;
  readonly actions: readonly string[] | null;
  readonly granted_at: string | null;
  readonly delegation_expires_at: string | null;
  readonly delegation_state: string | null;
  readonly delegate_person_id: string | null;
  readonly covering: readonly {
    readonly id: string;
    readonly collection: string;
    readonly action: string;
    readonly scopeKind: string;
  }[];
}

/**
 * One row per lease on the read's lineages. `$1` is the business, and
 * `lineages` is the snapshot's own scope (`readVerifiedProjection`).
 */
export const SCOPES: string = `select row_number() over (order by lease.acquired_at, lease.id) as ordinal,
            run.lineage_id,
            lease.id as lease_id,
            lease.acquired_at,
            d.id as delegation_id,
            d.purpose,
            d.purpose_scope_kind,
            d.purpose_scope_id,
            d.collections,
            d.actions,
            d.granted_at,
            d.expires_at as delegation_expires_at,
            case when d.id is null then null
                 when d.revoked_at is not null then 'revoked'
                 when d.settled_at is not null then 'settled'
                 when d.expires_at <= now() then 'expired'
                 else 'live' end as delegation_state,
            d.delegate_person_id,
            coalesce(covering.grants, '[]'::json) as covering
       from public.leases lease
       join public.planned_runs run
         on run.business_id = lease.business_id and run.id = lease.run_id
       left join public.delegations d
         on d.business_id = lease.business_id and d.id = lease.delegation_id
       left join lateral (
         ${EFFECTIVE_GRANTS}
         select json_agg(json_build_object(
                  'id', e.id, 'collection', e.collection, 'action', e.action,
                  'scopeKind', e.scope_kind)
                  order by e.collection, e.action, e.id) as grants
           from effective e
          where e.business_id = lease.business_id
            and e.subject_kind = 'person'
            and e.subject_id = d.delegate_person_id
            and e.collection = any (d.collections)
            and e.action = any (d.actions)
            and (e.scope_kind = 'business'
                 or (e.scope_kind = 'record' and e.scope_id = lease.task_id))
       ) covering on d.id is not null
      where lease.business_id = $1
        and run.lineage_id in (select lineage_id from lineages)`;

/** The lineage's scopes, oldest lease first. */
export function scopesOf(rows: readonly ScopeRow[], lineageId: string): readonly RunScopeView[] {
  return rows
    .filter((row) => row.lineage_id === lineageId)
    .map((row) => ({
      leaseId: row.lease_id,
      acquiredAt: isoTime(row.acquired_at),
      delegation:
        row.delegation_id === null
          ? null
          : {
              id: row.delegation_id,
              purpose: row.purpose ?? '',
              scope: { kind: row.purpose_scope_kind ?? '', id: row.purpose_scope_id ?? '' },
              collections: row.collections ?? [],
              actions: row.actions ?? [],
              grantedAt: isoTime(row.granted_at),
              expiresAt: isoTime(row.delegation_expires_at),
              state: row.delegation_state ?? 'unknown',
              delegatePersonId: row.delegate_person_id ?? '',
              grants: row.covering,
            },
    }));
}

const isoTime = (text: string | null): string => new Date(text ?? 0).toISOString();
