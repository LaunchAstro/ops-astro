// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of AW-06's suites: one schedules business on a fresh
// database, reads through the production read entry, and the few steps the
// cases take through the production command entries.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { executeRead, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { boundPlanOf } from '../../packages/core-runtime/src/index.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  createTask,
  freshPurpose,
  openSchedules,
  pickup,
  propose,
  proposeBody,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { acceptAs, acceptRequest, PLAN, PLAN_TEXT } from './aw-04-world.ts';

export const noDatabase: boolean = process.env['DATABASE_URL'] === undefined;

export type Answer = Awaited<ReturnType<typeof executeRead>>;
export type Node = {
  readonly nodeId: string;
  readonly condition: string;
  readonly planned: unknown;
  readonly observed: Readonly<Record<string, unknown>>;
};
export type PlanStepNode = {
  readonly key: string;
  readonly title: string;
  readonly after: readonly string[];
  readonly runIds: readonly string[];
};
export type Graph = {
  readonly plan: string;
  readonly planRecordId?: string | null;
  readonly planRunId?: string | null;
  readonly steps?: readonly PlanStepNode[];
  readonly sourceRevision: number;
  readonly complete: boolean;
  readonly nodes: readonly Node[];
};

/** The suite's world, filled by `useAw06World`. */
export const w = {} as { s: Schedules };

export function useAw06World(part: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    w.s = await openSchedules(part, 1_000_000);
    // The decider raises an envelope for the runs proposed under a plan (T2e).
    await w.s.db.app.withBusiness(
      w.s.business,
      async (tx) => await grantTo(tx, w.s.decider, 'decide', undefined, false, 'billing'),
    );
  }, 180_000);
  afterAll(async () => {
    if (noDatabase) return;
    await w.s.db.drop();
  });
}

export async function readIn(business: BusinessId, who: Member, recordId: string): Promise<Answer> {
  return await executeRead(w.s.db.app, business, who.presented, {
    read: 'task.execution',
    recordId,
  } as never);
}

export async function readAs(who: Member, recordId: string): Promise<Answer> {
  return await readIn(w.s.business, who, recordId);
}

/** The graph an answer carries, or undefined. */
export function graphIn(answer: Answer): Graph | undefined {
  return (answer as { readonly execution?: { readonly graph?: Graph } }).execution?.graph;
}

/** The graph an applied read carries, or a throw naming what came back instead. */
export function graphOf(answer: Answer, what: string): Graph {
  if (isCommandRefusal(answer)) throw new Error(`${what}: refused ${answer.code}`);
  const graph = graphIn(answer);
  if (graph === undefined) throw new Error(`${what}: no graph in ${JSON.stringify(answer)}`);
  return graph;
}

export async function graphAs(who: Member, recordId: string): Promise<Graph> {
  return graphOf(await readAs(who, recordId), recordId);
}

export function nodeOf(graph: Graph, runId: unknown): Node {
  const node = graph.nodes.find((each) => each.nodeId === runId);
  if (node === undefined) throw new Error(`no node for run ${String(runId)}`);
  return node;
}

/** A proposal on a fresh task, refused by the decider through `task.decide`. */
export async function refusedProposal(title: string): Promise<{ taskId: string }> {
  const taskId = await createTask(w.s, title);
  const proposal = await propose(w.s, taskId, { maximumMinor: 500, purpose: freshPurpose() });
  appliedDetail(
    await asPerson(w.s, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'reject',
      note: 'not this one',
    }),
    'task.decide reject',
  );
  return { taskId };
}

/** Picked-up work on a step the runtime can reconcile, so a dispatch is admitted. */
export async function reconcilableWork(title: string): Promise<{ taskId: string; picked: Detail }> {
  const taskId = await createTask(w.s, title);
  const body = proposeBody(taskId, await revisionOf(w.s, taskId), {
    maximumMinor: 2_000,
    purpose: freshPurpose(),
  });
  const proposal = appliedDetail(
    await asPerson(w.s, { ...body, step: { kind: 'synthetic_comment', payload: {} } }),
    'task.propose',
  );
  const picked = await pickup(w.s, (await approve(w.s, proposal))['reservationId']);
  return { taskId, picked };
}

/** A plan accepted on a task through the real accept (AW-04): its gate, decision, run and record. */
export interface AcceptedPlan {
  readonly taskId: string;
  readonly gateId: string;
  readonly decisionId: string;
  readonly runId: string;
  readonly planRecordId: string;
}

/** `record` (AW-04's `PLAN` by default) proposed on `taskId` and accepted by the decider. */
export async function acceptPlanOn(
  taskId: string,
  record: unknown = PLAN,
  text: string = PLAN_TEXT,
): Promise<AcceptedPlan> {
  const proposal = await propose(w.s, taskId, { maximumMinor: 500, purpose: freshPurpose() });
  const plan = boundPlanOf(text, record);
  if ('field' in plan) throw new Error(plan.reason);
  const accepted = await acceptAs(w.s, {
    ...acceptRequest(w.s, { taskId, proposal }),
    plan,
  });
  if (!accepted.ok) throw new Error(`acceptPlan refused ${accepted.refusal.code}`);
  // The envelope opened at the plan's own ceiling; room for the runs proposed
  // under it, raised by the person who approved it (T2e).
  const [envelope] = await rows<{ maximum: string }>(
    w.s,
    `select maximum_minor::text as maximum from public.task_envelopes
      where task_id = $1 and state = 'open'`,
    [taskId],
  );
  appliedDetail(
    await asPerson(w.s, {
      command: 'budget.top_up',
      operationId: randomUUID(),
      recordId: taskId,
      amountMinor: 50_000,
      fromMaximumMinor: Number(envelope?.maximum),
    }),
    'budget.top_up',
  );
  const { gateId, decisionId, runId, planRecordId } = accepted.value;
  return { taskId, gateId, decisionId, runId, planRecordId };
}

/** `task.propose` on `taskId` with `step` as sent, answered as it came back. */
export async function proposeStep(taskId: string, step: unknown): Promise<CommandResult> {
  const body = proposeBody(taskId, await revisionOf(w.s, taskId), {
    maximumMinor: 300,
    purpose: freshPurpose(),
  });
  return await asPerson(w.s, { ...body, step });
}

export interface AgentCalls {
  readonly dispatch: () => Promise<Detail>;
  readonly comment: () => Promise<Detail>;
  readonly observe: () => Promise<Detail>;
}

/** The agent's calls on picked-up work, under its lease and credential. */
export function agentOn(taskId: string, picked: Detail): AgentCalls {
  const lease = { leaseId: picked['leaseId'], fence: picked['fence'] };
  const credential = String(picked['credential']);
  const attemptId = String(picked['attemptId']);
  const call = async (body: Record<string, unknown>, what: string): Promise<Detail> =>
    appliedDetail(await asAgent(w.s, body, credential), what);
  return {
    dispatch: async () =>
      await call({ command: 'task.dispatch', operationId: randomUUID(), ...lease }, 'dispatch'),
    comment: async () =>
      await call(
        {
          command: 'task.comment',
          operationId: effectOperationId(attemptId),
          recordId: taskId,
          body: 'The synthetic change, applied once.',
          audience: 'internal',
        },
        'task.comment',
      ),
    observe: async () =>
      await call(
        {
          command: 'task.observe',
          operationId: randomUUID(),
          ...lease,
          attemptId,
          usage: { item: 'synthetic_comment', quantity: 1 },
        },
        'task.observe',
      ),
  };
}
