// SPDX-License-Identifier: AGPL-3.0-only
//
// Case (c)'s move for `decision-evidence-binding.test.ts`, kept here so the
// suite reads as its cases. The statements run in the order the move makes them.

import { randomUUID } from 'node:crypto';
import { digestOf } from '../../packages/core-runtime/src/signing.ts';
import type { World } from '../acceptance/world.ts';

/** The decided gate and the version it was decided on. */
interface DecidedGate {
  readonly gateId: string;
  readonly versionId: string;
}

/** Writes one statement: the application role's transaction, or the owner. */
type Run = (text: string, parameters: readonly unknown[]) => Promise<void>;

/** The identifiers the move mints for the forged version and what hangs off it. */
interface Forged {
  readonly v9: string;
  readonly r9: string;
  readonly s9: string;
  readonly p9: string;
}

/**
 * Case (c)'s move: a superseded version with a larger ceiling and its own
 * consistent pack added to the lineage, and the decided gate moved onto it.
 * `run` is the writer: the application role's transaction, or the owner.
 */
export async function moveDecidedGate(world: World, on: DecidedGate, run: Run): Promise<void> {
  const packs = await world.db.admin.execute<{ readonly rendered: Record<string, unknown> }>(
    'select rendered from public.evidence_packs where business_id = $1 and version_id = $2',
    [world.alpha, on.versionId],
  );
  const forged: Record<string, unknown> = {
    ...packs[0]?.rendered,
    version: 99,
    bound: { maximumMinor: 999_999, currency: 'AUD' },
  };
  const ids: Forged = { v9: randomUUID(), r9: randomUUID(), s9: randomUUID(), p9: randomUUID() };
  const v = [world.alpha, on.versionId] as const;
  await copyVersionAndRun(run, v, ids);
  await run(
    `insert into public.evidence_packs
       (business_id, id, version_id, run_id, rendered, rendered_digest, version_digest, renderer)
     select business_id, $3, $4, $5, $6::text::jsonb, $7, version_digest, renderer
       from public.evidence_packs where business_id = $1 and version_id = $2`,
    [...v, ids.p9, ids.v9, ids.r9, JSON.stringify(forged), digestOf(forged)],
  );
  await run(
    `update public.gates set version_id = $3, run_id = $4, step_id = $5, evidence_pack_id = $6
      where business_id = $1 and id = $2`,
    [world.alpha, on.gateId, ids.v9, ids.r9, ids.s9, ids.p9],
  );
}

/** The forged version, its planned run and that run's step, copied from the decided version. */
async function copyVersionAndRun(
  run: Run,
  v: readonly [string, string],
  { v9, r9, s9 }: Forged,
): Promise<void> {
  await run(
    `insert into public.proposal_versions
       (business_id, id, lineage_id, version, payload, payload_digest, purpose,
        maximum_minor, currency, proposed_by_actor_id, superseded_at)
     select business_id, $3, lineage_id, 99, payload, payload_digest, purpose,
            999999, currency, proposed_by_actor_id, now()
       from public.proposal_versions where business_id = $1 and id = $2`,
    [...v, v9],
  );
  await run(
    `insert into public.planned_runs (business_id, id, lineage_id, version_id, task_id, state)
     select business_id, $3, lineage_id, $4, task_id, state
       from public.planned_runs where business_id = $1 and version_id = $2`,
    [...v, r9, v9],
  );
  await run(
    `insert into public.planned_steps (business_id, id, run_id, ordinal, kind, payload)
     select s.business_id, $3, $4, s.ordinal, s.kind, s.payload
       from public.planned_steps s
       join public.planned_runs r on r.business_id = s.business_id and r.id = s.run_id
      where s.business_id = $1 and r.version_id = $2`,
    [...v, s9, r9],
  );
}
