// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-06, the observed layer of the execution graph, against a real database.
// `task.execution` carries a projection beside its runs and events: one node
// per run, with a planned layer and an observed layer that are never merged.
// The planned layer is AW-04's bound plan record (SL12), not on this branch,
// so every node's planned layer is null and the graph says the plan is
// unbound rather than inventing one. The observed layer is read from the
// run's own rows (run, gate, version, lease, attempts, reservations) in the
// same snapshot as the events, so a page of events never changes a condition.
//
// Every read goes through the production read entry, and every write the
// cases make goes through the production command entries.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import { enrol, grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  createTask,
  freshPurpose,
  handbackBody,
  liveWork,
  pickup,
  propose,
  rows,
} from './schedules-harness.ts';
import {
  agentOn,
  graphAs,
  graphOf,
  nodeOf,
  noDatabase,
  readAs,
  reconcilableWork,
  refusedProposal,
  useAw06World,
  w,
} from './aw-06-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('aw06');

it('AW-06 observed in progress: a claimed run shows its attempt and whose move, and the planned layer is null, never invented', async () => {
  const work = await liveWork(w.s, `aw06-progress-${randomUUID()}`, 1_000);
  const graph = await graphAs(w.s.decider, work.taskId);
  expect(graph.plan).toBe('unbound');
  expect(graph.nodes).toHaveLength(1);
  const node = nodeOf(graph, work.picked['runId']);
  expect(node.planned).toBeNull();
  expect(node.condition).toBe('in_progress');
  expect(node.observed).toMatchObject({
    condition: 'in_progress',
    runState: 'claimed',
    attemptId: work.picked['attemptId'],
    whoseMove: { kind: 'agent', actorId: w.s.agentActorId },
    outcome: null,
    fault: null,
  });
});

it('AW-06 observed settled: a hand-back settles with its outcome, and a refused gate settles as a refusal', async () => {
  const work = await liveWork(w.s, `aw06-settled-${randomUUID()}`, 1_000);
  appliedDetail(
    await asAgent(w.s, handbackBody(work.picked), String(work.picked['credential'])),
    'task.handback',
  );
  const settled = nodeOf(await graphAs(w.s.decider, work.taskId), work.picked['runId']);
  expect(settled.condition).toBe('settled');
  expect(settled.observed).toMatchObject({
    condition: 'settled',
    outcome: 'completed',
    whoseMove: null,
  });

  const { taskId } = await refusedProposal(`aw06-refused-${randomUUID()}`);
  const graph = await graphAs(w.s.decider, taskId);
  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes[0]?.observed).toMatchObject({
    condition: 'settled',
    outcome: 'refused',
    attemptId: null,
  });
});

/** The run planned for a version. */
async function runOf(versionId: unknown): Promise<string | undefined> {
  const found = await rows<{ readonly id: string }>(
    w.s,
    `select id::text as id from public.planned_runs where business_id = $1 and version_id = $2`,
    [w.s.business, versionId],
  );
  return found[0]?.id;
}

it('AW-06 observed superseded: a version replaced on its lineage shows as superseded, beside its successor', async () => {
  const taskId = await createTask(w.s, `aw06-superseded-${randomUUID()}`);
  const purpose = freshPurpose();
  const first = await propose(w.s, taskId, { maximumMinor: 500, purpose });
  const second = await propose(w.s, taskId, {
    maximumMinor: 600,
    purpose,
    lineageId: String(first['lineageId']),
  });
  const graph = await graphAs(w.s.decider, taskId);
  expect(graph.nodes).toHaveLength(2);
  expect(nodeOf(graph, await runOf(first['versionId'])).condition).toBe('superseded');
  expect(nodeOf(graph, await runOf(second['versionId'])).condition).toBe('not_started');
});

it('AW-06 silent run: with no progress after its claim a run stays in progress to its lease expiry, and past it, undropped, it is still not settled', async () => {
  const taskId = await createTask(w.s, `aw06-silent-${randomUUID()}`);
  const proposal = await propose(w.s, taskId, { maximumMinor: 500, purpose: freshPurpose() });
  const decision = await approve(w.s, proposal);
  const picked = await pickup(w.s, decision['reservationId'], 1);
  const early = nodeOf(await graphAs(w.s.decider, taskId), picked['runId']);
  expect(early.observed).toMatchObject({ condition: 'in_progress' });
  const lease = early.observed['lease'] as { state: string; expiresAt: string };
  expect(Date.parse(lease.expiresAt)).toBeGreaterThan(0);

  // Past the lease's expiry and before any reaper: no drop, so no settlement.
  await sleep(1_500);
  const late = nodeOf(await graphAs(w.s.decider, taskId), picked['runId']);
  expect(late.condition).toBe('in_progress');
  expect(late.observed).toMatchObject({
    condition: 'in_progress',
    outcome: null,
    lease: { state: 'lapsed', expiresAt: lease.expiresAt },
  });
});

it('AW-06 absent spend is never zero: nothing spent reads null, live and after a hand-back that reported none', async () => {
  const work = await liveWork(w.s, `aw06-spend-${randomUUID()}`, 1_000);
  const live = nodeOf(await graphAs(w.s.decider, work.taskId), work.picked['runId']);
  expect(live.observed).toMatchObject({ spentMinor: null, heldMinor: 1_000, currency: 'AUD' });

  appliedDetail(
    await asAgent(w.s, handbackBody(work.picked), String(work.picked['credential'])),
    'task.handback',
  );
  const after = nodeOf(await graphAs(w.s.decider, work.taskId), work.picked['runId']);
  expect(after.observed).toMatchObject({ condition: 'settled', spentMinor: null, heldMinor: null });
});

it('AW-06 a staged intent satisfies nothing: a dispatched attempt shows no observed effect and no spend until its observation', async () => {
  const { taskId, picked } = await reconcilableWork(`aw06-staged-${randomUUID()}`);
  const agent = agentOn(taskId, picked);
  await agent.dispatch();
  const staged = nodeOf(await graphAs(w.s.decider, taskId), picked['runId']);
  expect(staged.observed).toMatchObject({
    condition: 'in_progress',
    effectObserved: false,
    spentMinor: null,
  });

  // The effect applies and is observed: now, and only now, it counts.
  await agent.comment();
  await agent.observe();
  const observed = nodeOf(await graphAs(w.s.decider, taskId), picked['runId']);
  expect(observed.observed).toMatchObject({ effectObserved: true, spentMinor: 1_800 });
});

it('AW-06 immutable projection: the answer is frozen and the same read twice is the same bytes', async () => {
  const work = await liveWork(w.s, `aw06-frozen-${randomUUID()}`, 1_000);
  const answer = await readAs(w.s.decider, work.taskId);
  const graph = graphOf(answer, 'frozen');
  expect(Object.isFrozen(graph)).toBe(true);
  expect(Object.isFrozen(graph.nodes)).toBe(true);
  expect(Object.isFrozen(graph.nodes[0])).toBe(true);
  expect(Object.isFrozen(graph.nodes[0]?.observed)).toBe(true);
  expect(JSON.stringify(await readAs(w.s.decider, work.taskId))).toBe(JSON.stringify(answer));
});

/** Every key anywhere in a value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (value === null || typeof value !== 'object') return into;
  for (const [key, inner] of Object.entries(value)) {
    into.add(key);
    keysOf(inner, into);
  }
  return into;
}

it('AW-06 no authority: a reader with read alone and a reader with every grant get the same projection, and it names no permission', async () => {
  const work = await liveWork(w.s, `aw06-authority-${randomUUID()}`, 1_000);
  const reader = await enrol(w.s.db.app, w.s.business, 'aw06-reader');
  await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await grantTo(tx, reader, 'read', { kind: 'record', id: work.taskId }),
  );
  const narrow = await graphAs(reader, work.taskId);
  const wide = await graphAs(w.s.decider, work.taskId);
  expect(JSON.stringify(narrow)).toBe(JSON.stringify(wide));
  for (const key of keysOf(wide)) {
    expect(key, key).not.toMatch(/can|allow|permit|grant|authori|action|decide/iu);
  }
});
