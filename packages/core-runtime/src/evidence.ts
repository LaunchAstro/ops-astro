// SPDX-License-Identifier: AGPL-3.0-only
//
// The evidence renderer (G07).
//
// It reads the version, the run and the steps that were actually written and
// builds the pack from them. A caller cannot hand it a pack: `renderEvidence`
// takes two identifiers and no content, which is the only way "a test cannot
// insert a non-empty JSON object instead" is a fact about the interface rather
// than a rule in a review checklist.
//
// It stores `version_digest` beside its own `rendered_digest` so the decision
// can compare the pack it is approving against the version it is approving,
// and refuse `EVIDENCE_MISMATCH` on a stale pack rather than binding the
// approval to whichever of the two the reader happened to trust.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import { digestOf } from './signing.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

export const RENDERER = 'core-runtime/evidence@1';

export interface RenderedPack {
  readonly evidencePackId: string;
  readonly renderedDigest: string;
  readonly versionDigest: string;
  readonly rendered: Record<string, unknown>;
}

interface VersionRow {
  readonly id: string;
  readonly lineage_id: string;
  readonly version: number;
  readonly payload: Record<string, unknown>;
  readonly payload_digest: string;
  readonly purpose: string;
  readonly maximum_minor: string;
  readonly currency: string;
}

interface RunRow {
  readonly id: string;
  readonly task_id: string;
  readonly state: string;
}

interface StepRow {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly dispatched_at: Date | null;
}

export async function renderEvidence(
  tx: TenantQuery,
  of: { readonly versionId: string; readonly runId: string },
): Promise<RuntimeResult<RenderedPack>> {
  const versions = await tx.query<VersionRow>(
    `select id, lineage_id, version, payload, payload_digest, purpose, maximum_minor::text as maximum_minor, currency
       from public.proposal_versions where business_id = $1 and id = $2`,
    [tx.businessId, of.versionId],
  );
  const version = versions[0];
  if (version === undefined) {
    return refuse(
      'GATE_NOT_FOUND',
      'no such proposal version to render evidence from',
      'Render the pack in the same transaction that wrote the version.',
    );
  }

  const runs = await tx.query<RunRow>(
    `select id, task_id, state from public.planned_runs
      where business_id = $1 and id = $2 and version_id = $3`,
    [tx.businessId, of.runId, of.versionId],
  );
  const run = runs[0];
  if (run === undefined) {
    return refuse(
      'EVIDENCE_MISMATCH',
      `run ${of.runId} does not belong to version ${of.versionId}`,
      'Render the pack for the run this version planned.',
    );
  }

  const steps = await tx.query<StepRow>(
    `select id, ordinal, kind, payload, dispatched_at from public.planned_steps
      where business_id = $1 and run_id = $2 order by ordinal`,
    [tx.businessId, of.runId],
  );
  // G01: a gate over a run with no steps describes work nobody planned.
  if (steps.length === 0) {
    return refuse(
      'EVIDENCE_MISMATCH',
      `run ${of.runId} has no steps, so there is nothing to render evidence about`,
      'Plan at least one step before rendering.',
    );
  }

  const rendered: Record<string, unknown> = {
    renderer: RENDERER,
    lineage: version.lineage_id,
    version: version.version,
    task: run.task_id,
    purpose: version.purpose,
    bound: { maximumMinor: Number(version.maximum_minor), currency: version.currency },
    payload: version.payload,
    steps: steps.map((step) => ({
      ordinal: step.ordinal,
      kind: step.kind,
      payload: step.payload,
      // Stated, not omitted. An approver reading this pack is being told that
      // nothing here has been dispatched, rather than being left to infer it.
      dispatched: step.dispatched_at !== null,
    })),
    externalEffect: false,
    providerRequested: false,
  };

  const renderedDigest = digestOf(rendered);
  const evidencePackId = randomUUID();
  await tx.query(
    `insert into public.evidence_packs
       (business_id, id, version_id, run_id, rendered, rendered_digest, version_digest, renderer)
     values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8)`,
    [
      tx.businessId,
      evidencePackId,
      of.versionId,
      of.runId,
      JSON.stringify(rendered),
      renderedDigest,
      version.payload_digest,
      RENDERER,
    ],
  );

  return {
    ok: true,
    value: { evidencePackId, renderedDigest, versionDigest: version.payload_digest, rendered },
  };
}
