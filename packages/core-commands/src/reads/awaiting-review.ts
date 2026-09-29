// SPDX-License-Identifier: AGPL-3.0-only
//
// `gate.pending`: the one awaiting-review read (MP-6-1, TR-P-14).
//
// The gate engine's pending decisions, as a list a review surface draws: every
// gate still waiting on a person, on a live lineage's current version, on a
// task that is not in the trash, whose deadline has not passed. The review
// lists (MP-8-1, MP-8-3, MP-11-6, MP-11-7) read this and build no second query.
//
// It is filtered by the caller's own `decide` (the catalogue's `gate:decide`)
// inside the statement that reads the gates: a business-wide grant sees every
// task's gates, a record-scoped one only its records' gates. A caller holding
// no `decide` anywhere is refused rather than answered with an empty list,
// because a denied list is not a success with nothing in it. The deadline is
// the database's `now()` with the decide path's inclusive boundary, so the list
// never offers a gate the decision would refuse `GATE_EXPIRED`.

import { coveredScopes, subjectsOf } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { AwaitingReviewView } from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';

interface PendingRow {
  readonly gate_id: string;
  readonly version_id: string;
  readonly version: string;
  readonly lineage_id: string;
  readonly task_id: string;
  readonly title: string | null;
  readonly purpose: string;
  readonly maximum_minor: string;
  readonly currency: string;
  readonly round: number;
  readonly expires_at: Date;
}

const PENDING = `select g.id as gate_id, ver.id as version_id, ver.version::text as version,
            lin.id as lineage_id, r.id as task_id, r.txt_4 as title, ver.purpose,
            ver.maximum_minor::text as maximum_minor, ver.currency, g.round, g.expires_at
       from public.gates g
       join public.proposal_versions ver
         on ver.business_id = g.business_id and ver.id = g.version_id
       join public.proposal_lineages lin
         on lin.business_id = ver.business_id and lin.id = ver.lineage_id
       join public.records r
         on r.business_id = lin.business_id and r.id = lin.task_id
      where g.business_id = $1
        and r.record_type_id = $2
        and r.deleted_at is null
        and g.state = 'pending'
        and g.expires_at > now()
        and lin.state = 'live'
        and ver.superseded_at is null
        and ($3::boolean or r.id = any($4::uuid[]))
      order by g.expires_at, g.id`;

export async function readAwaitingReview(
  tx: TenantQuery,
  session: Session,
  taskTypeId: string,
  collection: string,
): Promise<readonly AwaitingReviewView[] | CommandRefusal> {
  const scopes = await coveredScopes(tx, subjectsOf(session), { collection, action: 'decide' });
  if (!scopes.business && scopes.records.length === 0) {
    return refuseCommand(
      'SCOPE_NOT_GRANTED',
      [],
      ['no live grant covers it', 'ask a holder who may delegate'],
    );
  }
  const rows = await tx.query<PendingRow>(PENDING, [
    tx.businessId,
    taskTypeId,
    scopes.business,
    scopes.records,
  ]);
  return rows.map((row) => ({
    gateId: row.gate_id,
    versionId: row.version_id,
    version: Number(row.version),
    lineageId: row.lineage_id,
    taskId: row.task_id,
    taskTitle: row.title ?? '',
    purpose: row.purpose,
    maximumMinor: Number(row.maximum_minor),
    currency: row.currency,
    round: row.round,
    expiresAt: new Date(row.expires_at).toISOString(),
  }));
}
