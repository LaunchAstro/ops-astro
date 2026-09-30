// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-06, the planned layer of the execution graph, against a real database.
// The plan is AW-04's structured record, bound to the decision that approved
// it by the real accept. The graph projects a record only where that binding
// holds, and places each run under the plan step its proposal named (ORCH41
// decision (a)): a run naming no step, or a step the plan lacks, is shown
// unplanned. A key is checked at the proposal against the task's bound plan.
//
// Every read goes through the production read entry; the plan is accepted by
// the production accept and the runs proposed through the production command
// entry. The forged plan records are written by the product's own database
// role, as any code holding it could.

import { createHash, randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { payloadDigest } from '../../packages/core-digest/src/index.ts';
import { appliedDetail, approve, codeOf, createTask, rows } from './schedules-harness.ts';
import {
  acceptPlanOn,
  graphAs,
  nodeOf,
  noDatabase,
  proposeStep,
  useAw06World,
  w,
  type AcceptedPlan,
  type Graph,
} from './aw-06-world.ts';
import { PLAN, PLAN_TEXT } from './aw-04-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('aw06plan');

/** A structurally valid plan nobody approved. */
const FORGED = { steps: [{ key: 'forged', title: 'A step nobody approved', after: [] }] };
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The accepted plan's projection: its record, its run and its two steps. */
function expectProjects(graph: Graph, plan: AcceptedPlan, what: string): void {
  expect(graph, what).toMatchObject({
    plan: 'bound',
    planRecordId: plan.planRecordId,
    planRunId: plan.runId,
  });
  expect(
    graph.steps?.map((step) => [step.key, step.title, step.after]),
    what,
  ).toEqual(PLAN.steps.map((step) => [step.key, step.title, step.after]));
  expect(JSON.stringify(graph), what).not.toContain('forged');
}

/** Another plan version on the task, approved by `task.decide`: no record bound to it. */
async function approvedWithoutRecord(
  taskId: string,
): Promise<{ gateId: string; decisionId: string; runId: string }> {
  const proposal = appliedDetail(
    await proposeStep(taskId, { kind: 'synthetic_comment', payload: {} }),
    'task.propose',
  );
  const decided = await rows<{ decision_id: string }>(
    w.s,
    `select id::text as decision_id from public.gate_decisions where gate_id = $1`,
    [proposal['gateId']],
  );
  expect(decided).toHaveLength(0);
  await approve(w.s, proposal);
  const [row] = await rows<{ decision_id: string }>(
    w.s,
    `select id::text as decision_id from public.gate_decisions where gate_id = $1`,
    [proposal['gateId']],
  );
  return {
    gateId: String(proposal['gateId']),
    decisionId: String(row?.decision_id),
    runId: String(proposal['runId']),
  };
}

interface Forged {
  readonly gateId: string;
  readonly decisionId: string;
  readonly runId: string;
  readonly record: unknown;
  readonly recordDigest: string;
  /** Written as the decision's own instant, or left to the insert's clock. */
  readonly withDecision: boolean;
}

/** A plan record written by the product's own role, as any code holding it could. */
async function forge(row: Forged): Promise<void> {
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(
      `insert into public.plan_records (business_id, id, gate_id, decision_id, run_id,
         plan_text, text_digest, record, record_digest, bound_by_actor_id, bound_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               case when $11 then (select decided_at from public.gate_decisions
                                    where business_id = $1 and id = $4)
                    else now() end)`,
      [
        w.s.business,
        randomUUID(),
        row.gateId,
        row.decisionId,
        row.runId,
        PLAN_TEXT,
        sha256(PLAN_TEXT),
        row.record,
        row.recordDigest,
        w.s.decider.actorId,
        row.withDecision,
      ],
    );
  });
}

it('projection_refuses_unbound_record: a record the plan decision did not bind is never projected, and the bound record still is', async () => {
  const taskId = await createTask(w.s, `aw06-bound-${randomUUID()}`);
  const plan = await acceptPlanOn(taskId);
  expectProjects(await graphAs(w.s.decider, taskId), plan, 'the accepted plan');

  // Each forged record is newer than the bound one and structurally valid, so
  // neither recency nor shape is what refuses it.
  const late = await approvedWithoutRecord(taskId);
  await forge({
    ...late,
    record: FORGED,
    recordDigest: payloadDigest(FORGED),
    withDecision: false,
  });
  expectProjects(await graphAs(w.s.decider, taskId), plan, 'written after its decision');

  const digest = await approvedWithoutRecord(taskId);
  await forge({ ...digest, record: FORGED, recordDigest: payloadDigest(PLAN), withDecision: true });
  expectProjects(await graphAs(w.s.decider, taskId), plan, 'a digest its decision did not bind');

  const gate = await approvedWithoutRecord(taskId);
  const decision = await approvedWithoutRecord(taskId);
  await forge({
    gateId: gate.gateId,
    runId: gate.runId,
    decisionId: decision.decisionId,
    record: FORGED,
    recordDigest: payloadDigest(FORGED),
    withDecision: true,
  });
  expectProjects(await graphAs(w.s.decider, taskId), plan, 'another gate’s decision');

  const run = await approvedWithoutRecord(taskId);
  await forge({
    ...run,
    runId: gate.runId,
    record: FORGED,
    recordDigest: payloadDigest(FORGED),
    withDecision: true,
  });
  expectProjects(await graphAs(w.s.decider, taskId), plan, 'another run');

  // Control: a record bound as the accept binds it is projected, and the newest wins.
  const replaced = { steps: [{ key: 'outline', title: 'Outline the brief', after: [] }] };
  const second = await acceptPlanOn(taskId, replaced);
  const graph = await graphAs(w.s.decider, taskId);
  expect(graph).toMatchObject({ plan: 'bound', planRecordId: second.planRecordId });
  expect(graph.steps?.map((step) => step.key)).toEqual(['outline']);
});

it('projection_refuses_unbound_record: a task with no bound record says unbound, never an empty plan', async () => {
  const taskId = await createTask(w.s, `aw06-unbound-${randomUUID()}`);
  const late = await approvedWithoutRecord(taskId);
  await forge({
    ...late,
    record: FORGED,
    recordDigest: payloadDigest(FORGED),
    withDecision: false,
  });
  const graph = await graphAs(w.s.decider, taskId);
  expect(graph).toMatchObject({ plan: 'unbound', planRecordId: null, planRunId: null, steps: [] });
  expect(nodeOf(graph, late.runId)).toMatchObject({ planned: null, condition: 'not_started' });
});

/** The plan step key a run's step stores, and the one its evidence pack shows the approver. */
async function stepKeyOf(runId: unknown): Promise<{ stored: unknown; shown: unknown }> {
  const [pack] = await rows<{ key: string | null; rendered: string }>(
    w.s,
    `select st.plan_step_key as key, ep.rendered::text as rendered
       from public.planned_steps st
       join public.evidence_packs ep on ep.run_id = st.run_id
      where st.run_id = $1`,
    [runId],
  );
  const rendered = JSON.parse(String(pack?.rendered)) as { steps: { planStep?: unknown }[] };
  return { stored: pack?.key, shown: rendered.steps[0]?.planStep };
}

it('unplanned_is_shown: a run under a plan step is planned, and a run naming no step, or a step the plan lacks, shows as unplanned', async () => {
  const taskId = await createTask(w.s, `aw06-unplanned-${randomUUID()}`);
  const plan = await acceptPlanOn(taskId);
  const planned = appliedDetail(
    await proposeStep(taskId, { kind: 'synthetic_comment', payload: {}, planStep: 'draft' }),
    'propose under draft',
  );
  const unplanned = appliedDetail(
    await proposeStep(taskId, { kind: 'synthetic_comment', payload: {} }),
    'propose with no step key',
  );

  const graph = await graphAs(w.s.decider, taskId);
  expect(graph.steps?.map((step) => [step.key, step.runIds])).toEqual([
    ['draft', [planned['runId']]],
    ['check', []],
  ]);
  expect(nodeOf(graph, planned['runId'])).toMatchObject({
    condition: 'not_started',
    planned: { key: 'draft', title: 'Draft the brief' },
    observed: { condition: 'not_started' },
  });
  expect(nodeOf(graph, unplanned['runId'])).toMatchObject({
    condition: 'unplanned',
    planned: null,
    observed: { condition: 'not_started' },
  });
  // The plan's own run is the plan, not a step outside it.
  expect(nodeOf(graph, plan.runId).condition).not.toBe('unplanned');

  // The step key is stored on the run's step and shown to the approver.
  expect(await stepKeyOf(planned['runId'])).toEqual({ stored: 'draft', shown: 'draft' });

  // A plan bound later without that step leaves the run under a key the plan
  // lacks: it is shown unplanned, never dropped or re-homed.
  await acceptPlanOn(taskId, { steps: [{ key: 'outline', title: 'Outline it', after: [] }] });
  const replaced = await graphAs(w.s.decider, taskId);
  expect(nodeOf(replaced, planned['runId'])).toMatchObject({
    condition: 'unplanned',
    planned: null,
  });
});

it('unplanned_is_shown: a step key the bound plan lacks, or any key on a task with no bound plan, is refused at the proposal and writes nothing', async () => {
  const taskId = await createTask(w.s, `aw06-key-${randomUUID()}`);
  await acceptPlanOn(taskId);
  const before = await rows<{ n: string }>(
    w.s,
    `select count(*)::text as n from public.planned_runs where task_id = $1`,
    [taskId],
  );
  for (const planStep of ['publish', 'DRAFT', ' draft', 7, ['draft'], null]) {
    // One at a time: each proposal reads the task's revision the last left.
    // oxlint-disable-next-line no-await-in-loop
    const answer = await proposeStep(taskId, { kind: 'synthetic_comment', payload: {}, planStep });
    expect(codeOf(answer), JSON.stringify(planStep)).toBe('FIELD_VALUE_INVALID');
    expect(JSON.stringify(answer)).toContain('"step"');
  }
  const after = await rows<{ n: string }>(
    w.s,
    `select count(*)::text as n from public.planned_runs where task_id = $1`,
    [taskId],
  );
  expect(after).toEqual(before);

  const bare = await createTask(w.s, `aw06-key-bare-${randomUUID()}`);
  const answer = await proposeStep(bare, {
    kind: 'synthetic_comment',
    payload: {},
    planStep: 'draft',
  });
  expect(codeOf(answer)).toBe('FIELD_VALUE_INVALID');
  expect(JSON.stringify(answer)).not.toContain('Draft the brief');
});
