// SPDX-License-Identifier: AGPL-3.0-only
//
// `definition.attribution` (AW-04): which runs read one instruction file, by
// its digest, and what those runs reached. A projection over the read ledger
// (`bootstrap_reads`, entry and non-entry alike) and the model calls, labelled
// pre-review on every row: it may floor a declaration of reach and nothing
// else, and no evaluation, promotion or conformance input takes it. Only the
// catalogue row loads this module (`pre-review-attribution-stays-in-its-read`
// in .dependency-cruiser.cjs).
//
// It is the team's: a reader outside it is refused as one holding no grant, a
// denied list never being an empty success. Each run is filtered by the
// caller's `read` on its task inside the statement, as `gate.pending` filters
// by `decide`: a business-wide grant sees every task's runs, a record-scoped
// one only its own tasks'. A trashed task's runs are not listed.

import { coveredScopes, subjectsOf } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { PreReviewAttribution, PreReviewRun } from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import { isInternalReader } from './tasks.ts';

/** A file's digest as the ledger keeps it: 64 lowercase hex. */
export const DIGEST: RegExp = /^[0-9a-f]{64}$/u;

interface RunRow {
  readonly task_id: string;
  readonly run_id: string;
  readonly paths: readonly string[];
  readonly entry: boolean;
  readonly operations: readonly string[];
}

// A call refused before it was sent reached nothing.
const RUNS = `select pr.task_id, b.run_id,
            array_agg(distinct b.path order by b.path) as paths,
            bool_or(b.is_entry) as entry,
            coalesce((select array_agg(distinct mc.operation_key order by mc.operation_key)
                        from public.model_calls mc
                       where mc.business_id = b.business_id and mc.run_id = b.run_id
                         and mc.state <> 'refused'), '{}') as operations
       from public.bootstrap_reads b
       join public.planned_runs pr on pr.business_id = b.business_id and pr.id = b.run_id
       join public.records r on r.business_id = pr.business_id and r.id = pr.task_id
      where b.business_id = $1
        and b.content_digest = $2
        and r.record_type_id = $3
        and r.deleted_at is null
        and ($4::boolean or r.id = any($5::uuid[]))
      group by pr.task_id, b.business_id, b.run_id
      order by b.run_id`;

export async function readAttribution(
  tx: TenantQuery,
  session: Session,
  taskTypeId: string,
  digest: string,
): Promise<PreReviewAttribution | CommandRefusal> {
  const scopes = await coveredScopes(tx, subjectsOf(session), {
    collection: 'task',
    action: 'read',
  });
  if (!isInternalReader(session.roleKey) || (!scopes.business && scopes.records.length === 0)) {
    return refuseCommand(
      'SCOPE_NOT_GRANTED',
      [],
      ['no live grant covers it', 'ask a holder who may delegate'],
    );
  }
  const rows = await tx.query<RunRow>(RUNS, [
    tx.businessId,
    digest,
    taskTypeId,
    scopes.business,
    scopes.records,
  ]);
  const runs: PreReviewRun[] = rows.map((row) => ({
    label: 'pre-review',
    taskId: row.task_id,
    runId: row.run_id,
    paths: row.paths,
    entry: row.entry,
    operations: row.operations,
  }));
  return {
    label: 'pre-review',
    digest,
    runs,
    operations: [...new Set(runs.flatMap((run) => run.operations))].toSorted(),
  };
}
