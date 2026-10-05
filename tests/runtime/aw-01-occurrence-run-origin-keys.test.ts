// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 J joined to C33 (P11b security read SEC-P11B-1, minor): a run's
// origin names a real occurrence and a real definition of its own business,
// and a dispatch's run is a run of its own business, held by the database
// past the code. Any application code may take the occurrence role for one
// statement, so without these keys a run naming no occurrence, or another
// business's, would stand as an approved occurrence's run.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  authorityFor,
  noDatabase,
  occurrence,
  start,
  useOccurrenceWorld,
  w,
} from './occurrence-run-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useOccurrenceWorld('aw01key');

/** One run insert through the occurrence role in alpha, as AW-01 J's own write takes it. */
const runAsOccurrenceRole = async (origin: {
  readonly taskId: string;
  readonly occurrenceId: string;
  readonly definitionId: string;
}) =>
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(`select set_config('role', 'ops_astro_occurrence', true)`);
    await tx.query(
      `insert into public.planned_runs (business_id, id, task_id, origin_occurrence_id,
         origin_definition_id, origin_approved_by_actor_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        w.s.business,
        randomUUID(),
        origin.taskId,
        origin.occurrenceId,
        origin.definitionId,
        w.s.decider.actorId,
      ],
    );
  });

const started = async (on: typeof w.s, worker: string) => {
  const occurrenceId = await occurrence(on);
  const run = await start(on, occurrenceId, authorityFor(on), worker);
  if (!run.ok) throw new Error(`refused ${run.refusal.code}`);
  return { ...run.value, occurrenceId };
};

it("AW-01 occurrence run: a run whose origin names no occurrence, or another business's occurrence or definition, is refused by the database", async () => {
  const alpha = authorityFor(w.s);
  const { taskId } = await started(w.s, w.worker);
  const bravoOccurrence = await occurrence(w.bravo);
  const bravoDefinition = authorityFor(w.bravo).definitionId;
  expect(bravoDefinition).not.toBe(alpha.definitionId);

  await expect(
    runAsOccurrenceRole({ taskId, occurrenceId: randomUUID(), definitionId: alpha.definitionId }),
  ).rejects.toThrow(/planned_runs_origin_occurrence_fkey/u);
  await expect(
    runAsOccurrenceRole({
      taskId,
      occurrenceId: bravoOccurrence,
      definitionId: alpha.definitionId,
    }),
  ).rejects.toThrow(/planned_runs_origin_occurrence_fkey/u);
  await expect(
    runAsOccurrenceRole({
      taskId,
      occurrenceId: await occurrence(w.s),
      definitionId: bravoDefinition,
    }),
  ).rejects.toThrow(/planned_runs_origin_definition_fkey/u);
  // The same write naming alpha's own occurrence and definition stands.
  await expect(
    runAsOccurrenceRole({
      taskId,
      occurrenceId: await occurrence(w.s),
      definitionId: alpha.definitionId,
    }),
  ).resolves.toBeUndefined();
});

/** A started dispatch of an alpha occurrence (a fresh one unless named), naming `runId`. */
const dispatch = async (runId: string, occurrenceId?: string) =>
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(
      `insert into public.occurrence_dispatches (business_id, id, occurrence_id, outcome, run_id)
       values ($1, $2, $3, 'started', $4)`,
      [w.s.business, randomUUID(), occurrenceId ?? (await occurrence(w.s)), runId],
    );
  });

it("AW-01 occurrence run: a dispatch naming no run, another business's run, or the run of another occurrence, is refused by the database", async () => {
  const bravoRun = await started(w.bravo, w.bravoWorker);
  await expect(dispatch(randomUUID())).rejects.toThrow(/occurrence_dispatches_run_fkey/u);
  await expect(dispatch(bravoRun.runId)).rejects.toThrow(/occurrence_dispatches_run_fkey/u);
  const alphaRun = await started(w.s, w.worker);
  // Alpha's own run, named by a dispatch of another alpha occurrence.
  await expect(dispatch(alphaRun.runId)).rejects.toThrow(/occurrence_dispatches_run_fkey/u);
  await expect(dispatch(alphaRun.runId, alphaRun.occurrenceId)).resolves.toBeUndefined();
});
