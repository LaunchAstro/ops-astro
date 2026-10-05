// SPDX-License-Identifier: AGPL-3.0-only
//
// An occurrence run carries no plan (no lineage, no version), and a
// conversation that started one still counts it as its work: open while
// planned, so it holds the conversation body (AW-03).
import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { workOf } from '../../packages/core-commands/src/commands/conversation-work.ts';
import { authorityFor, noDatabase, start, useOccurrenceWorld, w } from './occurrence-run-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useOccurrenceWorld('occurrence_conversation_work');

it('an occurrence run a conversation started is its open work, with no plan to join', async () => {
  const started = await start(w.s, randomUUID(), authorityFor(w.s), w.worker);
  if (!started.ok) throw new Error(`refused ${started.refusal.code}`);
  const conversationId = randomUUID();
  await w.s.db.admin.execute(
    `insert into public.conversations (business_id, id, owner_actor_id, owner_person_id, title)
     values ($1, $2, $3, $4, 'The occurrence is conversation work')`,
    [w.s.business, conversationId, w.s.decider.actorId, w.s.decider.personId],
  );
  const [run] = await w.s.db.admin.execute<{ lineage_id: string | null; state: string }>(
    `update public.planned_runs set origin_conversation_id = $2 where id = $1
      returning lineage_id, state`,
    [started.value.runId, conversationId],
  );
  expect(run).toEqual({ lineage_id: null, state: 'planned' });
  const work = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await workOf(tx, conversationId, null),
  );
  expect(work).toEqual([
    expect.objectContaining({
      pointer: expect.objectContaining({ kind: 'run', id: started.value.runId }),
      terminal: false,
    }),
  ]);
});
