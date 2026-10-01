// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 J, who may write an occurrence run and who may reach one (ORCH36
// conditions 1, 2 and 5): only an active worker of this business, through the
// occurrence role the application may take for one statement and never
// inherits; pickup can never reach such a run; and the three crossings:
// another business, another client in the same business, another person (an
// agent under a live delegation).

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeRead, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { queue } from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { asAgent, codeOf as commandCode, rows } from './schedules-harness.ts';
import {
  authorityFor,
  codeOf,
  footprint,
  insertWorker,
  noDatabase,
  start,
  useOccurrenceWorld,
  w,
} from './occurrence-run-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useOccurrenceWorld('aw01occi');

const asApp = async (text: string, parameters: readonly unknown[]) =>
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(text, parameters);
  });

const clientOf = async (taskId: string) =>
  (
    await rows<{ readonly client: string | null }>(
      w.s,
      `select data ->> 'client' as client from public.records where business_id = $1 and id = $2`,
      [w.s.business, taskId],
    )
  )[0]?.client;

const refusedAs = async (actor: string) => {
  const before = await footprint();
  const refused = await start(w.s, randomUUID(), authorityFor(w.s), actor);
  expect(await footprint(), actor).toStrictEqual(before);
  return codeOf(refused);
};

it('AW-01 occurrence run: only an active worker of this business writes it, never a person or an agent under a live delegation', async () => {
  const inactive = await insertWorker(w.s, false);
  const [delegation] = await rows<{ readonly live: boolean }>(
    w.s,
    `select revoked_at is null and expires_at > now() as live
       from public.delegations where business_id = $1 and id = $2`,
    [w.s.business, String(w.work.picked['delegationId'])],
  );
  expect(delegation?.live).toBe(true);
  for (const actor of [
    w.s.decider.actorId,
    w.s.agentActorId,
    inactive,
    w.bravoWorker,
    randomUUID(),
    'worker-1',
    '',
  ]) {
    // Sequential: each refusal is measured against the footprint before it.
    // eslint-disable-next-line no-await-in-loop
    expect(await refusedAs(actor), actor).toBe('WORKER_REQUIRED');
  }
});

it('AW-01 occurrence run: the application role cannot write an occurrence run itself', async () => {
  const started = await start(w.s, randomUUID(), authorityFor(w.s), w.worker);
  if (!started.ok) throw new Error(`refused ${started.refusal.code}`);
  await expect(
    asApp(
      `insert into public.planned_runs (business_id, id, task_id, origin_occurrence_id)
       values ($1, $2, $3, $4)`,
      [w.s.business, randomUUID(), started.value.taskId, randomUUID()],
    ),
  ).rejects.toThrow(/OCCURRENCE_RUN_ROLE/u);
  // Nor move an existing run off, or onto, an occurrence: the application may
  // update a run's state alone (0192), and past that, the trigger refuses
  // even the owner.
  const moveOff = `update public.planned_runs set origin_occurrence_id = null,
      origin_definition_id = null, origin_approved_by_actor_id = null
    where business_id = $1 and id = $2`;
  await expect(asApp(moveOff, [w.s.business, started.value.runId])).rejects.toThrow(
    /permission denied for table planned_runs/u,
  );
  await expect(
    w.s.db.admin.execute(moveOff, [w.s.business, started.value.runId] as never),
  ).rejects.toThrow(/OCCURRENCE_RUN_ROLE/u);
  const [grants] = await rows<Record<string, boolean>>(
    w.s,
    `select has_function_privilege('public', 'public.planned_runs_occurrence_origin()', 'execute') as public_execute,
            pg_has_role('ops_astro_app', 'ops_astro_occurrence', 'usage') as app_inherits,
            has_table_privilege('ops_astro_occurrence', 'public.leases', 'insert') as role_leases,
            has_table_privilege('ops_astro_occurrence', 'public.planned_runs', 'update') as role_updates,
            has_table_privilege('ops_astro_worker', 'public.planned_runs', 'insert') as worker_runs`,
    [],
  );
  expect(grants).toStrictEqual({
    public_execute: false,
    app_inherits: false,
    role_leases: false,
    role_updates: false,
    worker_runs: false,
  });
});

it('AW-01 occurrence run: pickup can never reach one', async () => {
  const started = await start(w.s, randomUUID(), authorityFor(w.s), w.worker);
  if (!started.ok) throw new Error(`refused ${started.refusal.code}`);
  // Pickup works from a reservation on an approved plan version; an
  // occurrence run has none, and the database refuses one naming it.
  const listed = await w.s.db.app.withBusiness(w.s.business, async (tx) => await queue(tx));
  expect(listed.map((entry) => entry.runId)).not.toContain(started.value.runId);
  const [held] = await rows<{ readonly id: string }>(
    w.s,
    `select id from public.reservations where business_id = $1 limit 1`,
    [w.s.business],
  );
  await expect(
    w.s.db.admin.execute(
      `update public.reservations set run_id = $3 where business_id = $1 and id = $2`,
      [w.s.business, held?.id, started.value.runId] as never,
    ),
  ).rejects.toThrow(/reservations_run_in_same_version/u);
});

it('AW-01 occurrence run isolation: another business', async () => {
  // Bravo's worker starts its own run for the same occurrence id; neither
  // business sees or answers the other's.
  const occurrenceId = randomUUID();
  const alpha = await start(w.s, occurrenceId, authorityFor(w.s), w.worker);
  const other = await start(w.bravo, occurrenceId, authorityFor(w.bravo), w.bravoWorker);
  if (!alpha.ok || !other.ok) throw new Error('an occurrence run was refused');
  expect(other.value.runId).not.toBe(alpha.value.runId);
  expect(other.value.replayed).toBe(false);
  const seen = await w.bravo.db.app.withBusiness(
    w.bravo.business,
    async (tx) =>
      await tx.query<{ readonly n: string }>(
        `select count(*)::text as n from public.planned_runs where id = $1 or task_id = $2`,
        [alpha.value.runId, alpha.value.taskId],
      ),
  );
  expect(seen[0]?.n).toBe('0');
  const foreign = await executeRead(w.s.db.app, w.bravo.business, w.bravo.decider.presented, {
    read: 'task.read',
    recordId: alpha.value.taskId,
  } as never);
  expect(foreign).toMatchObject({ code: 'NOT_FOUND' });
});

it('AW-01 occurrence run isolation: another client in the same business', async () => {
  // Each definition's task lands on its own client; a client of the other
  // reads nothing of it.
  const [clientOne, clientTwo] = [randomUUID(), randomUUID()];
  const one = await start(w.s, randomUUID(), authorityFor(w.s, { clientId: clientOne }), w.worker);
  const two = await start(w.s, randomUUID(), authorityFor(w.s, { clientId: clientTwo }), w.worker);
  if (!one.ok || !two.ok) throw new Error('an occurrence run was refused');
  expect([await clientOf(one.value.taskId), await clientOf(two.value.taskId)]).toStrictEqual([
    clientOne,
    clientTwo,
  ]);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, w.s.decider, 'share');
  });
  const wrongClient = await cq8World(w.s).client(
    w.s.business,
    w.s.decider,
    'aw01occi-two',
    two.value.taskId,
  );
  const readBy = async (recordId: string) =>
    await executeRead(w.s.db.app, w.s.business, wrongClient.presented, {
      read: 'task.read',
      recordId,
    } as never);
  expect(await readBy(two.value.taskId)).toHaveProperty('sharedTask');
  const crossed = await readBy(one.value.taskId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  expect(JSON.stringify(crossed)).not.toContain(clientOne);
});

it('AW-01 occurrence run isolation: another person under a live delegation', async () => {
  // The agent acts for the decider under a live delegation for its own task:
  // it can neither start an occurrence run nor reach the task one landed on.
  const started = await start(w.s, randomUUID(), authorityFor(w.s), w.worker);
  if (!started.ok) throw new Error(`refused ${started.refusal.code}`);
  expect(codeOf(await start(w.s, randomUUID(), authorityFor(w.s), w.s.agentActorId))).toBe(
    'WORKER_REQUIRED',
  );
  const credential = String(w.work.picked['credential']);
  const readAsAgent = async (command: string, recordId: string) =>
    await asAgent(w.s, { command, operationId: randomUUID(), recordId }, credential);
  expect(commandCode(await readAsAgent('task.read', w.work.taskId))).toBe('applied');
  const crossed = await readAsAgent('task.execution', started.value.taskId);
  expect(isCommandRefusal(crossed) ? crossed.code : 'applied').toBe(
    'DELEGATION_EXCLUDES_OPERATION',
  );
  expect(JSON.stringify(crossed)).not.toContain(started.value.runId);
});
