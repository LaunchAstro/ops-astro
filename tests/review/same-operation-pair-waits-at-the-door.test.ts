// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #413, #932: one operation identity presented on two tasks at once.
// The second request waits at the envelope's door, before any lock or record of
// its own, until the first commits, then answers from the first's record. So
// nothing the first does after its final liveness read can wait on the second,
// and the two cannot deadlock.
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
  waitPast,
} from '../runtime/schedules-harness.ts';

useChildWorld('authz6door');
const it = noDatabase ? vitestIt.skip : vitestIt;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const deadlocks = async (): Promise<number> =>
  await scalar(
    w.s,
    'select deadlocks::text as n from pg_stat_database where datname = current_database()',
    [],
  );

/** Backends parked on the advisory lock `key`, as `advisoryLock` spells it. */
const parkedOn = async (key: string): Promise<number> =>
  await scalar(
    w.s,
    `select count(*)::text as n
       from pg_locks l, (select hashtextextended($1, 0) as k) h
      where l.locktype = 'advisory' and not l.granted and l.objsubid = 1
        and l.classid::bigint = (h.k >> 32) & 4294967295
        and l.objid::bigint = h.k & 4294967295`,
    [key],
  );

interface Race {
  readonly agentTask: string;
  readonly personTask: string;
  readonly personRevision: number;
  readonly childId: string;
  readonly operationId: string;
  readonly atDoor: number;
  readonly results: readonly [
    Awaited<ReturnType<typeof executeCommand>>,
    Awaited<ReturnType<typeof executeCommand>>,
  ];
}

/**
 * The assignment holds the identity and queues on the audit chain's lock; the
 * person write, same identity, another task, starts on its own connection.
 * `whileParked` runs before the audit lock is let go.
 */
async function race(whileParked: (parentId: string) => Promise<void>): Promise<Race> {
  const { parent } = await parentWork(w.s);
  const minted = await child(w.s, parent, w.helper);
  const agentTask = parent.purposeScope.id;
  const personTask = await createTask(w.s, `authz6 ${randomUUID()}`);
  const operationId = randomUUID();
  const send = (database: Database, recordId: string, fields: Record<string, string>) =>
    revisionOf(w.s, recordId).then(
      async (revision) =>
        await executeCommand(database, w.s.business, w.s.decider.presented, 'api', {
          command: 'task.assign',
          operationId,
          recordId,
          expectedRevision: revision,
          fields,
        }),
    );
  const personRevision = await revisionOf(w.s, personTask);
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
  try {
    const assigning = send(w.s.db.app, agentTask, { agent: minted.delegation.id });
    await awaitParked(w.s, 'advisory', 1);
    const assigningPerson = send(second, personTask, { assignee: w.s.decider.personId });
    await awaitParked(w.s, 'advisory', 2);
    const door = `operation:${w.s.business}:${w.s.decider.actorId}:${operationId}`;
    const atDoor = await parkedOn(door);
    await whileParked(parent.id);
    gate.release();
    await held;
    const results = [await assigning, await assigningPerson] as const;
    return {
      agentTask,
      personTask,
      personRevision,
      childId: minted.delegation.id,
      operationId,
      atDoor,
      results,
    };
  } finally {
    gate.release();
    await database.close();
    await second.close();
  }
}

const count = async (sql: string, operationId: string): Promise<string | undefined> =>
  (await w.s.db.admin.execute<{ readonly n: string }>(sql, [w.s.business, operationId]))[0]?.n;

it('one operation identity on two tasks at once: the second waits at the door and answers from the first, with no deadlock', async () => {
  const before = await deadlocks();
  const run = await race(async () => {});
  expect(run.atDoor, 'the person write waits at the door, holding no record').toBe(1);
  expect(codeOf(run.results[0])).toBe('not-a-refusal');
  expect(codeOf(run.results[1])).toBe('OPERATION_ID_REUSED');
  expect(await revisionOf(w.s, run.personTask), 'the second wrote nothing').toBe(
    run.personRevision,
  );
  const operations = `select count(*)::text as n from public.operations
                       where business_id = $1 and operation_id = $2`;
  expect(await count(operations, run.operationId), 'one operation record').toBe('1');
  const applied = `select count(*)::text as n from public.audit_events
                    where business_id = $1 and operation_id = $2 and outcome = 'applied'`;
  expect(await count(applied, run.operationId), 'one applied audit event').toBe('1');
  // A backend reports a deadlock when it next goes idle, within its ten-second flush.
  await pause(11_000);
  expect(await deadlocks(), 'no deadlock').toBe(before);
}, 60_000);

it('a parent that expires while a same-identity request waits at the door refuses the assignment', async () => {
  const run = await race(async (parentId) => {
    await w.s.db.admin.execute(
      `update public.delegations set expires_at = clock_timestamp() + interval '1 second'
        where business_id = $1 and id = $2`,
      [w.s.business, parentId],
    );
    await waitPast(w.s, 'select expires_at from public.delegations where id = $1', parentId);
  });
  expect(run.atDoor, 'the person write waits at the door, holding no record').toBe(1);
  expect(codeOf(run.results[0])).toBe('DELEGATION_NOT_LIVE');
  const stored = await w.s.db.admin.execute<{ readonly agent: string | null }>(
    `select data ->> 'agent' as agent from public.records where business_id = $1 and id = $2`,
    [w.s.business, run.agentTask],
  );
  expect(stored[0]?.agent).not.toBe(run.childId);
  expect(codeOf(run.results[1])).toBe('OPERATION_ID_REUSED');
  expect(await revisionOf(w.s, run.personTask), 'the second wrote nothing').toBe(
    run.personRevision,
  );
}, 60_000);
