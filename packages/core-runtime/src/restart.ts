// SPDX-License-Identifier: AGPL-3.0-only
//
// G05: an authorised restart opens a new lineage. It never reopens the old one.
//
// The restart is a proposal. What makes it a restart is only the provenance:
// the new lineage names the rejected or cancelled one it replaces in
// `restarts_lineage_id`, which 0010 declared for exactly this and nothing has
// written until now. So this module reads what the terminal lineage last asked
// for (its latest version and that version's step) and hands it to `propose`
// with `restartsLineageId`, where the old lineage is locked, checked terminal
// and not already restarted, in the same ordered lock set as everything else
// the proposal touches.
//
// What a restart does **not** carry over: the old version's gate, decision,
// reservation, lease or delegation. The new lineage starts at version 1 with a
// pending gate and no hold, so a person decides again (no auto approval), and
// the old hold stays released by whatever made the lineage terminal.

import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import type { Subject } from '../../core-records/src/authority/grants.ts';
import { propose, type Proposal } from './propose.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

export interface RestartRequest {
  readonly taskId: string;
  readonly collection: string;
  /** The rejected or cancelled lineage being replaced. */
  readonly lineageId: string;
  readonly proposedByActorId: string;
  readonly subjects: readonly Subject[];
  readonly expiresAt: Date;
}

export interface Restarted extends Proposal {
  readonly restartsLineageId: string;
}

export async function restart(
  tx: TenantQuery,
  request: RestartRequest,
): Promise<RuntimeResult<Restarted>> {
  // Read-only, before `propose` takes its locks. A terminal lineage's versions
  // are never written again, so what is read here cannot change under it; the
  // lineage's own state is re-read under its lock inside `propose`.
  const rows = await tx.query<{
    readonly purpose: string;
    readonly maximum_minor: string;
    readonly currency: string;
    readonly payload: Record<string, unknown>;
    readonly step_kind: string | null;
    readonly step_payload: Record<string, unknown> | null;
  }>(
    `select v.purpose, v.maximum_minor::text as maximum_minor, v.currency, v.payload,
            st.kind as step_kind, st.payload as step_payload
       from public.proposal_versions v
       left join public.planned_runs run
         on run.business_id = v.business_id and run.version_id = v.id
       left join public.planned_steps st
         on st.business_id = v.business_id and st.run_id = run.id and st.ordinal = 1
      where v.business_id = $1 and v.lineage_id = $2
      order by v.version desc
      limit 1`,
    [tx.businessId, request.lineageId],
  );
  const last = rows[0];
  if (last === undefined) {
    return refuse(
      'GATE_NOT_FOUND',
      `no proposal lineage ${request.lineageId} in this business`,
      'Name the rejected or cancelled lineage this restart replaces.',
    );
  }

  const proposed = await propose(tx, {
    taskId: request.taskId,
    collection: request.collection,
    proposedByActorId: request.proposedByActorId,
    subjects: request.subjects,
    purpose: last.purpose,
    maximumMinor: Number(last.maximum_minor),
    currency: last.currency,
    payload: last.payload,
    step: { kind: last.step_kind ?? 'restart', payload: last.step_payload ?? {} },
    expiresAt: request.expiresAt,
    restartsLineageId: request.lineageId,
  });
  if (!proposed.ok) return proposed;
  return { ok: true, value: { ...proposed.value, restartsLineageId: request.lineageId } };
}
