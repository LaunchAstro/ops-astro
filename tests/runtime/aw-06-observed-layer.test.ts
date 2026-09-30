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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  createTask,
  freshPurpose,
  handbackBody,
  liveWork,
  openSchedules,
  pickup,
  propose,
  proposeBody,
  revisionOf,
  scalar,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/aw-06-observed-layer: DATABASE_URL is unset, so nothing below ran.');
}

type Answer = Awaited<ReturnType<typeof executeRead>>;
type Node = {
  readonly nodeId: string;
  readonly condition: string;
  readonly planned: unknown;
  readonly observed: Readonly<Record<string, unknown>>;
};
type Graph = {
  readonly plan: string;
  readonly sourceRevision: number;
  readonly complete: boolean;
  readonly nodes: readonly Node[];
};

/** The graph an applied read carries, or a throw naming what came back instead. */
function graphOf(answer: Answer, what: string): Graph {
  if (isCommandRefusal(answer)) throw new Error(`${what}: refused ${answer.code}`);
  const graph = (answer as { readonly execution?: { readonly graph?: Graph } }).execution?.graph;
  if (graph === undefined) throw new Error(`${what}: no graph in ${JSON.stringify(answer)}`);
  return graph;
}

function nodeOf(graph: Graph, runId: unknown): Node {
  const node = graph.nodes.find((each) => each.nodeId === runId);
  if (node === undefined) throw new Error(`no node for run ${String(runId)}`);
  return node;
}

describe.skipIf(serverUrl === undefined)('AW-06 the observed layer on a real database', () => {
  let s: Schedules;

  const readAs = async (who: Member, recordId: string): Promise<Answer> =>
    await executeRead(s.db.app, s.business, who.presented, {
      read: 'task.execution',
      recordId,
    } as never);
  const graphAs = async (who: Member, recordId: string): Promise<Graph> =>
    graphOf(await readAs(who, recordId), recordId);

  beforeAll(async () => {
    s = await openSchedules('aw06', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('AW-06 observed in progress: a claimed run shows its attempt and whose move, and the planned layer is null, never invented', async () => {
    const work = await liveWork(s, `aw06-progress-${randomUUID()}`, 1_000);
    const graph = await graphAs(s.decider, work.taskId);
    expect(graph.plan).toBe('unbound');
    expect(graph.nodes).toHaveLength(1);
    const node = nodeOf(graph, work.picked['runId']);
    expect(node.planned).toBeNull();
    expect(node.condition).toBe('in_progress');
    expect(node.observed).toMatchObject({
      condition: 'in_progress',
      runState: 'claimed',
      attemptId: work.picked['attemptId'],
      whoseMove: { kind: 'agent', actorId: s.agentActorId },
      outcome: null,
      fault: null,
    });
  });

  it('AW-06 observed settled: a hand-back settles with its outcome, and a refused gate settles as a refusal', async () => {
    const work = await liveWork(s, `aw06-settled-${randomUUID()}`, 1_000);
    appliedDetail(
      await asAgent(s, handbackBody(work.picked), String(work.picked['credential'])),
      'task.handback',
    );
    const settled = nodeOf(await graphAs(s.decider, work.taskId), work.picked['runId']);
    expect(settled.condition).toBe('settled');
    expect(settled.observed).toMatchObject({
      condition: 'settled',
      outcome: 'completed',
      whoseMove: null,
    });

    const taskId = await createTask(s, `aw06-refused-${randomUUID()}`);
    const proposal = await propose(s, taskId, { maximumMinor: 500, purpose: freshPurpose() });
    appliedDetail(
      await asPerson(s, {
        command: 'task.decide',
        operationId: randomUUID(),
        gateId: proposal['gateId'],
        versionId: proposal['versionId'],
        decision: 'reject',
        note: 'not this one',
      }),
      'task.decide reject',
    );
    const graph = await graphAs(s.decider, taskId);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.observed).toMatchObject({
      condition: 'settled',
      outcome: 'refused',
      attemptId: null,
    });
  });

  it('AW-06 observed superseded: a version replaced on its lineage shows as superseded, beside its successor', async () => {
    const taskId = await createTask(s, `aw06-superseded-${randomUUID()}`);
    const purpose = freshPurpose();
    const first = await propose(s, taskId, { maximumMinor: 500, purpose });
    const second = await propose(s, taskId, {
      maximumMinor: 600,
      purpose,
      lineageId: String(first['lineageId']),
    });
    const graph = await graphAs(s.decider, taskId);
    expect(graph.nodes).toHaveLength(2);
    const runOf = async (versionId: unknown) =>
      await scalar(
        s,
        `select id::text as n from public.planned_runs where business_id = $1 and version_id = $2`,
        [s.business, versionId],
      );
    expect(nodeOf(graph, await runOf(first['versionId'])).condition).toBe('superseded');
    expect(nodeOf(graph, await runOf(second['versionId'])).condition).toBe('not_started');
  });

  it('AW-06 silent run: with no progress after its claim a run stays in progress to its lease expiry, and past it, undropped, it is still not settled', async () => {
    const taskId = await createTask(s, `aw06-silent-${randomUUID()}`);
    const proposal = await propose(s, taskId, { maximumMinor: 500, purpose: freshPurpose() });
    const decision = await approve(s, proposal);
    const picked = await pickup(s, decision['reservationId'], 1);
    const early = nodeOf(await graphAs(s.decider, taskId), picked['runId']);
    expect(early.observed).toMatchObject({ condition: 'in_progress' });
    const lease = early.observed['lease'] as { state: string; expiresAt: string };
    expect(Date.parse(lease.expiresAt)).toBeGreaterThan(0);

    // Past the lease's expiry and before any reaper: no drop, so no settlement.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const late = nodeOf(await graphAs(s.decider, taskId), picked['runId']);
    expect(late.condition).toBe('in_progress');
    expect(late.observed).toMatchObject({
      condition: 'in_progress',
      outcome: null,
      lease: { state: 'lapsed', expiresAt: lease.expiresAt },
    });
  });

  it('AW-06 absent spend is never zero: nothing spent reads null, and a spend of zero reads 0', async () => {
    const work = await liveWork(s, `aw06-spend-${randomUUID()}`, 1_000);
    const live = nodeOf(await graphAs(s.decider, work.taskId), work.picked['runId']);
    expect(live.observed).toMatchObject({ spentMinor: null, heldMinor: 1_000, currency: 'AUD' });

    const zero = await liveWork(s, `aw06-zero-${randomUUID()}`, 1_000);
    appliedDetail(
      await asAgent(
        s,
        { ...handbackBody(zero.picked), actualMinor: 0 },
        String(zero.picked['credential']),
      ),
      'task.handback',
    );
    const spent = nodeOf(await graphAs(s.decider, zero.taskId), zero.picked['runId']);
    expect(spent.observed['spentMinor']).toBe(0);
    expect(spent.observed['heldMinor']).toBeNull();
  });

  it('AW-06 a staged intent satisfies nothing: a dispatched attempt with no observation shows no observed effect', async () => {
    // A step the runtime can reconcile, so the dispatch is admitted.
    const taskId = await createTask(s, `aw06-staged-${randomUUID()}`);
    const body = proposeBody(taskId, await revisionOf(s, taskId), {
      maximumMinor: 1_000,
      purpose: freshPurpose(),
    });
    const proposal = appliedDetail(
      await asPerson(s, { ...body, step: { kind: 'synthetic_comment', payload: {} } }),
      'task.propose',
    );
    const picked = await pickup(s, (await approve(s, proposal))['reservationId']);
    const work = { taskId, picked };
    const lease = { leaseId: picked['leaseId'], fence: picked['fence'] };
    const credential = String(picked['credential']);
    appliedDetail(
      await asAgent(
        s,
        { command: 'task.dispatch', operationId: randomUUID(), ...lease },
        credential,
      ),
      'task.dispatch',
    );
    const staged = nodeOf(await graphAs(s.decider, work.taskId), work.picked['runId']);
    expect(staged.observed).toMatchObject({ condition: 'in_progress', effectObserved: false });
  });

  it('AW-06 immutable projection: the answer is frozen and the same read twice is the same bytes', async () => {
    const work = await liveWork(s, `aw06-frozen-${randomUUID()}`, 1_000);
    const answer = await readAs(s.decider, work.taskId);
    const graph = graphOf(answer, 'frozen');
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.isFrozen(graph.nodes[0])).toBe(true);
    expect(Object.isFrozen(graph.nodes[0]?.observed)).toBe(true);
    expect(JSON.stringify(await readAs(s.decider, work.taskId))).toBe(JSON.stringify(answer));
  });

  it('AW-06 no authority: a reader with read alone and a reader with every grant get the same projection, and it names no permission', async () => {
    const work = await liveWork(s, `aw06-authority-${randomUUID()}`, 1_000);
    const reader = await enrol(s.db.app, s.business, 'aw06-reader');
    await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, reader, 'read', { kind: 'record', id: work.taskId }),
    );
    const narrow = await graphAs(reader, work.taskId);
    const wide = await graphAs(s.decider, work.taskId);
    expect(JSON.stringify(narrow)).toBe(JSON.stringify(wide));
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, inner] of Object.entries(value)) {
        keys.add(key);
        walk(inner);
      }
    };
    walk(wide);
    for (const key of keys) {
      expect(key, key).not.toMatch(/can|allow|permit|grant|authori|action|decide/i);
    }
  });

  it.todo('unplanned_is_shown (LEANS-ON SL12 AW-04: the bound structured plan record)');
  it.todo('projection_refuses_unbound_record (LEANS-ON SL12 AW-04: the plan decision binds it)');
});
