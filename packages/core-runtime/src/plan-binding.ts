// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-06: the one plan record a task's graph may project, and the one a
// proposal's plan step key is checked against.
//
// A record is bound when all of these hold, each re-read, never taken from
// the row's own say-so (`plan_records` is insert-only, but any code holding
// the product's role may insert one):
//
//   linked        its decision is an approval of its own gate, and its gate
//                 is its run's gate (0021 binds a gate's run to its version);
//   one write     it was written in its decision's transaction: `bound_at`
//                 is the decision's `decided_at`, both the transaction's
//                 clock, as AW-04's accept writes them together;
//   digests       SHA-256 of the words and the canonical digest of the record
//                 are recomputed and equal the row's;
//   shape         the record is a plan record (`planRecordOf`).
//
// Of the bound records on the task, the newest is the plan. A record failing
// any line is never projected, however new or well formed: structure is the
// last reason, not the first.

import { createHash } from 'node:crypto';
import { payloadDigest } from '../../core-digest/src/index.ts';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { planRecordOf, type PlanStep } from './plan-record.ts';

/** The task's projected plan: its record, the run it was accepted on, its steps. */
export interface ProjectedPlan {
  readonly planRecordId: string;
  readonly runId: string;
  readonly steps: readonly PlanStep[];
}

/**
 * Every plan record on a task's runs, newest first, with the facts the
 * binding needs, as one json value: `$1` the business, `$2` the task. A
 * fragment so the graph reads it in the same statement as its runs.
 */
export const PLAN_CANDIDATES = `coalesce((select json_agg(json_build_object(
    'id', pr.id, 'runId', pr.run_id, 'record', pr.record, 'recordDigest', pr.record_digest,
    'planText', pr.plan_text, 'textDigest', pr.text_digest,
    'linked', d.decision = 'approve' and d.gate_id = pr.gate_id and g.run_id = pr.run_id,
    'oneWrite', pr.bound_at = d.decided_at)
  order by pr.bound_at desc, pr.id desc)
  from public.plan_records pr
  join public.planned_runs run on run.business_id = pr.business_id and run.id = pr.run_id
  join public.gates g on g.business_id = pr.business_id and g.id = pr.gate_id
  join public.gate_decisions d on d.business_id = pr.business_id and d.id = pr.decision_id
 where pr.business_id = $1 and run.task_id = $2), '[]')`;

interface Candidate {
  readonly id: string;
  readonly runId: string;
  readonly record: unknown;
  readonly recordDigest: string;
  readonly planText: string;
  readonly textDigest: string;
  readonly linked: boolean;
  readonly oneWrite: boolean;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The newest bound record among `candidates` (`PLAN_CANDIDATES`), or null. */
export function projectedPlan(candidates: unknown): ProjectedPlan | null {
  if (!Array.isArray(candidates)) throw new Error('plan binding: the candidates are not a list');
  for (const candidate of candidates as readonly Candidate[]) {
    if (!(candidate.linked && candidate.oneWrite)) continue;
    if (sha256(candidate.planText) !== candidate.textDigest) continue;
    if (payloadDigest(candidate.record) !== candidate.recordDigest) continue;
    const record = planRecordOf(candidate.record);
    if (typeof record === 'string') continue;
    return { planRecordId: candidate.id, runId: candidate.runId, steps: record.steps };
  }
  return null;
}

/** The task's projected plan, read now; the caller holds the task's lock. */
export async function readProjectedPlan(
  tx: TenantQuery,
  taskId: string,
): Promise<ProjectedPlan | null> {
  const rows = await tx.query<{ readonly candidates: unknown }>(
    `select ${PLAN_CANDIDATES} as candidates`,
    [tx.businessId, taskId],
  );
  return projectedPlan(rows[0]?.candidates ?? []);
}
