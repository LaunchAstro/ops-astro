// SPDX-License-Identifier: AGPL-3.0-only
//
// A run an occurrence starts names that occurrence and its definition, and
// the database holds both past the dispatch code: the occurrence's outcome is
// `approved`, and the definition is the one its activation runs. Any
// application code may take the occurrence role for one statement, so a run
// on a refused or over-rate occurrence of the same business, or one naming
// another of its definitions, is refused at the insert.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { seedAutomation } from '../automations/seed.ts';
import {
  authorityFor,
  noDatabase,
  occurrence,
  useOccurrenceWorld,
  w,
} from './occurrence-run-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useOccurrenceWorld('approvedorigin');

/** One run insert through the occurrence role, its own transaction, as AW-01 J's write takes it. */
const runAsOccurrenceRole = async (occurrenceId: string, definitionId: string) =>
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(`select set_config('role', 'ops_astro_occurrence', true)`);
    await tx.query(
      `insert into public.planned_runs (business_id, id, task_id, origin_occurrence_id,
         origin_definition_id, origin_approved_by_actor_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [w.s.business, randomUUID(), w.work.taskId, occurrenceId, definitionId, w.s.decider.actorId],
    );
  });

const NOT_APPROVED = { code: '23514', message: expect.stringMatching(/approved occurrence/u) };

it.each(['activation_off', 'over_activation_rate'])(
  'a run on an occurrence recorded %s is refused',
  async (outcome) => {
    const definitionId = authorityFor(w.s).definitionId;
    await expect(
      runAsOccurrenceRole(await occurrence(w.s, outcome), definitionId),
    ).rejects.toMatchObject(NOT_APPROVED);
  },
);

it("a run naming a definition other than its occurrence's activation's is refused", async () => {
  const another = await seedAutomation(w.s.db.admin, w.s.business, w.s.decider.actorId);
  await expect(
    runAsOccurrenceRole(await occurrence(w.s), another.definitionId),
  ).rejects.toMatchObject(NOT_APPROVED);
  // The same write naming the occurrence's own definition stands.
  await expect(
    runAsOccurrenceRole(await occurrence(w.s), authorityFor(w.s).definitionId),
  ).resolves.toBeUndefined();
});
