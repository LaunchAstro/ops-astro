// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #413: a child assignment takes the audit chain's lock before its
// operation record, so one operation identity presented on two tasks at once
// can deadlock. Postgres aborts one whole transaction; its one retry reads the
// winner's record and is refused, and nothing it wrote survives.
import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { child, noDatabase, parentWork, useChildWorld, w } from '../runtime/aw-11-child-world.ts';
import {
  awaitParked,
  barrier,
  createTask,
  racer,
  revisionOf,
  scalar,
} from '../runtime/schedules-harness.ts';

useChildWorld('authz6deadlock');
const it = noDatabase ? vitestIt.skip : vitestIt;

const deadlocks = async (): Promise<number> =>
  await scalar(
    w.s,
    'select deadlocks::text as n from pg_stat_database where datname = current_database()',
    [],
  );

/** A backend reports its deadlock when it next goes idle, up to seconds later. */
async function deadlocksReach(count: number): Promise<number> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    // Polling is sequential by definition.
    // oxlint-disable-next-line no-await-in-loop
    const seen = await deadlocks();
    if (seen >= count) return seen;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  return await deadlocks();
}

it('one operation identity on two tasks at once: Postgres aborts one whole transaction', async () => {
  const { parent } = await parentWork(w.s);
  const minted = await child(w.s, parent, w.helper);
  const agentTask = parent.purposeScope.id;
  const personTask = await createTask(w.s, `authz6 ${randomUUID()}`);
  const operationId = randomUUID();
  const send = (
    database: Database,
    recordId: string,
    revision: number,
    fields: Record<string, string>,
  ) =>
    executeCommand(database, w.s.business, w.s.decider.presented, 'api', {
      command: 'task.assign',
      operationId,
      recordId,
      expectedRevision: revision,
      fields,
    });
  const agentRevision = await revisionOf(w.s, agentTask);
  const personRevision = await revisionOf(w.s, personTask);
  const before = await deadlocks();

  const database = racer(w.s);
  const second = racer(w.s);
  const locked = barrier();
  const gate = barrier();
  const held = database.withBusiness(w.s.business, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [w.s.business]);
    locked.release();
    await gate.held;
  });
  await locked.held;
  let results: readonly [Awaited<ReturnType<typeof send>>, Awaited<ReturnType<typeof send>>];
  try {
    // The assignment queues on the audit chain's lock first, holding no record.
    const assigning = send(w.s.db.app, agentTask, agentRevision, { agent: minted.delegation.id });
    await awaitParked(w.s, 'advisory', 1);
    // The person write, on a connection of its own, records the operation and
    // then queues behind it.
    const assigningPerson = send(second, personTask, personRevision, {
      assignee: w.s.decider.personId,
    });
    await awaitParked(w.s, 'advisory', 2);
    gate.release();
    await held;
    results = [await assigning, await assigningPerson];
  } finally {
    gate.release();
    await database.close();
    await second.close();
  }

  expect(await deadlocksReach(before + 1)).toBe(before + 1);
  const codes = results.map((result) => codeOf(result)).toSorted();
  expect(codes).toEqual(['OPERATION_ID_REUSED', 'not-a-refusal']);
  const loserTask = codeOf(results[0]) === 'OPERATION_ID_REUSED' ? agentTask : personTask;
  const loserRevision = loserTask === agentTask ? agentRevision : personRevision;
  expect(await revisionOf(w.s, loserTask), 'the loser wrote nothing').toBe(loserRevision);
  const stored = await w.s.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.operations
      where business_id = $1 and operation_id = $2`,
    [w.s.business, operationId],
  );
  expect(stored[0]?.n, 'one operation record, the winner').toBe('1');
  const applied = await w.s.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.audit_events
      where business_id = $1 and operation_id = $2 and outcome = 'applied'`,
    [w.s.business, operationId],
  );
  expect(applied[0]?.n, 'one applied audit event, the winner').toBe('1');
}, 60_000);
