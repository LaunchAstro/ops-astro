// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-06's security line, against a real database: the execution graph is
// never read across a business, a client or a person, the channel that tells
// an open page to read again carries no content, and a viewer whose access is
// revoked is refused at the next read.
//
// Each crossing has its positive control beside it, so a refusal here is not a
// read that never works. A canary title on the crossed task must never appear
// in any answer, refusals included, and neither may its id or its run's id.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import {
  executeAgentCommand,
  executeRead,
  isCommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import { connectListener } from '../../packages/core-records/src/tenancy/database.ts';
import { LIVE_CHANNEL } from '../../apps/api/live.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  handbackBody,
  liveWork,
  type Work,
} from './schedules-harness.ts';
import { cq8World } from './cq-8-world.ts';
import {
  acceptPlanOn,
  graphIn,
  noDatabase,
  readAs,
  readIn,
  refusedProposal,
  useAw06World,
  w,
  type Answer,
} from './aw-06-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('aw06iso');

/** The three crossings, each beside its own positive control. */
async function crossings(crossed: Work, own: Work, key = 'aw06') {
  const world = cq8World(w.s);

  // 1. Another business: its member reads its own task, and names this one.
  const other = await world.party(`${key}-other`);
  const otherTask = other.tasks[0]!;
  const otherOwn = await readIn(other.id, other.member, otherTask.id);
  expect(isCommandRefusal(otherOwn), 'other business, own task').toBe(false);
  const business = await readIn(other.id, other.member, crossed.taskId);

  // 2. Two clients here with one grant each: each reaches its own shared
  // task's record and neither reaches the other's execution.
  await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await grantTo(tx, w.s.decider, 'share'),
  );
  const first = await world.client(w.s.business, w.s.decider, `${key}-c1`, own.taskId);
  const second = await world.client(w.s.business, w.s.decider, `${key}-c2`, crossed.taskId);
  const clientOwn = await executeRead(w.s.db.app, w.s.business, first.presented, {
    read: 'task.read',
    recordId: own.taskId,
  } as never);
  expect(isCommandRefusal(clientOwn), 'client reads its own shared task').toBe(false);

  // 3. Another person's agent, under its own live delegation for its own
  // task, names the crossed task. The owning read serves no agent, so the
  // envelope answers; its own task still answers it (the positive control).
  const credential = String(own.picked['credential']);
  const agentOwn = await asAgent(
    w.s,
    { command: 'task.read', operationId: randomUUID(), recordId: own.taskId },
    credential,
  );
  expect(isCommandRefusal(agentOwn), 'the agent reads its own task').toBe(false);
  const person = await executeAgentCommand(w.s.db.app, w.s.business, w.s.agent, credential, {
    command: 'task.execution',
    operationId: randomUUID(),
    recordId: crossed.taskId,
  } as never);

  return {
    otherOwn,
    cases: [
      ['another business', business, 'NOT_FOUND'],
      ['client to client', await readAs(first, crossed.taskId), 'NOT_FOUND'],
      ['client to client, back', await readAs(second, own.taskId), 'NOT_FOUND'],
      ['another person under a live delegation', person, 'DELEGATION_EXCLUDES_OPERATION'],
    ] as const,
  };
}

it('AW-06 isolation: another business, another client in the same business and another person under a live delegation each read no graph and see no foreign id or canary', async () => {
  const canary = `aw06-canary-${randomUUID()}`;
  const crossed = await liveWork(w.s, canary, 1_000);
  const own = await liveWork(w.s, `aw06-own-${randomUUID()}`, 1_000);

  // Positive control: the owner reads the crossed task's graph, one node.
  expect(graphIn(await readAs(w.s.decider, crossed.taskId))?.nodes).toHaveLength(1);

  const { otherOwn, cases } = await crossings(crossed, own);
  const hidden = [canary, crossed.taskId, String(crossed.picked['runId'])];
  for (const [name, answer, code] of cases) {
    expect(isCommandRefusal(answer), name).toBe(true);
    expect(codeOf(answer as never), name).toBe(code);
    const body = JSON.stringify(answer);
    expect(body, name).not.toContain('"graph"');
    expect(body, name).not.toContain('"nodes"');
    const needles = name === 'client to client, back' ? [own.taskId] : hidden;
    for (const needle of needles) expect(body.includes(needle), `${name}: ${needle}`).toBe(false);
  }
  // The other business's answer about its own task names nothing of this one's.
  const foreignOwn = JSON.stringify(otherOwn);
  for (const needle of hidden) expect(foreignOwn.includes(needle), needle).toBe(false);
});

it('AW-06 planned isolation: a bound plan is projected to its own readers only; the three crossings see no step, record or canary, and another business cannot bind a record to this decision', async () => {
  const canary = `aw06-plan-canary-${randomUUID()}`;
  const taskId = await createTask(w.s, `aw06-planned-crossed-${randomUUID()}`);
  const plan = await acceptPlanOn(taskId, {
    steps: [{ key: 'canary', title: canary, after: [] }],
  });
  const own = await liveWork(w.s, `aw06-planned-own-${randomUUID()}`, 1_000);

  // Positive control: the owner reads the plan, canary title and all.
  const control = graphIn(await readAs(w.s.decider, taskId));
  expect(control).toMatchObject({ plan: 'bound', planRecordId: plan.planRecordId });
  expect(JSON.stringify(control)).toContain(canary);

  const crossed = { taskId, picked: { runId: plan.runId } } as unknown as Work;
  const { otherOwn, cases } = await crossings(crossed, own, 'aw06plan');
  const hidden = [canary, taskId, plan.runId, plan.planRecordId, plan.decisionId];
  for (const [name, answer, code] of cases) {
    expect(codeOf(answer as never), name).toBe(code);
    const body = JSON.stringify(answer);
    expect(body, name).not.toContain('"steps"');
    const needles = name === 'client to client, back' ? [own.taskId] : hidden;
    for (const needle of needles) expect(body.includes(needle), `${name}: ${needle}`).toBe(false);
  }
  const foreignOwn = JSON.stringify(otherOwn);
  for (const needle of hidden) expect(foreignOwn.includes(needle), needle).toBe(false);
  expect(graphIn(otherOwn)?.plan).toBe('unbound');

  // A write across: the other business's role names this business's decision,
  // gate and run for a record of its own. Nothing is written.
  const other = await cq8World(w.s).party('aw06-plan-writer');
  const forged = w.s.db.app.withBusiness(other.id, async (tx) => {
    await tx.query(
      `insert into public.plan_records (business_id, id, gate_id, decision_id, run_id,
         plan_text, text_digest, record, record_digest, bound_by_actor_id)
       values ($1, $2, $3, $4, $5, 'forged', repeat('0', 64), '{}'::jsonb, repeat('0', 64), $6)`,
      [other.id, randomUUID(), plan.gateId, plan.decisionId, plan.runId, other.member.actorId],
    );
  });
  await expect(forged).rejects.toThrow(/plan_records_(gate|decision|run|actor)_fkey|violates/u);
  const stored = await w.s.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.plan_records where decision_id = $1`,
    [plan.decisionId],
  );
  expect(stored).toEqual([{ n: '1' }]);
});

/** Every payload the live channel carries while `act` runs, until the topics it returns are heard. */
async function heardDuring(act: () => Promise<readonly string[]>): Promise<readonly string[]> {
  const payloads: string[] = [];
  const listener = connectListener(w.s.db.appUrl);
  try {
    const listening = new Promise<void>((resolve) => {
      void listener.listen(LIVE_CHANNEL, (payload) => payloads.push(payload), resolve);
    });
    await listening;
    const until = await act();
    for (let waited = 0; waited < 50; waited += 1) {
      if (until.every((topic) => payloads.includes(topic))) break;
      // eslint-disable-next-line no-await-in-loop -- polling the listener's buffer
      await sleep(100);
    }
    return payloads;
  } finally {
    await listener.close();
  }
}

it('AW-06 revoked: a viewer whose read is revoked is refused at the next read, and the channel carries only the topic, no content', async () => {
  const work = await liveWork(w.s, `aw06-revoked-${randomUUID()}`, 1_000);
  const viewer = await enrol(w.s.db.app, w.s.business, 'aw06-viewer');
  const grantId = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await grantTo(tx, viewer, 'read', { kind: 'record', id: work.taskId }),
  );
  expect(graphIn(await readAs(viewer, work.taskId))).toBeDefined();

  // The run moves (a hand-back), and a gate on another task is refused: every
  // notification is a bare topic, and both are heard.
  const topics: string[] = [];
  const payloads = await heardDuring(async () => {
    appliedDetail(
      await asAgent(w.s, handbackBody(work.picked), String(work.picked['credential'])),
      'task.handback',
    );
    const refused = await refusedProposal(`aw06-revoked-gate-${randomUUID()}`);
    topics.push(`${w.s.business}:task:${work.taskId}`, `${w.s.business}:task:${refused.taskId}`);
    return topics;
  });
  for (const topic of topics) expect(payloads).toContain(topic);
  // Batch 1's inbox raises its holders' items on the same channel, as bare topics too.
  for (const payload of payloads) {
    expect(payload).toMatch(/^[0-9a-f-]{36}:(?:task|inbox):[0-9a-f-]{36}$/u);
  }

  // The revoker manages task grants (the owning route asks `manage`).
  await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await grantTo(tx, w.s.decider, 'manage'),
  );
  const revoked = await asPerson(w.s, {
    command: 'grant.revoke',
    operationId: randomUUID(),
    grantId,
  });
  expect(isCommandRefusal(revoked), JSON.stringify(revoked)).toBe(false);
  const after: Answer = await readAs(viewer, work.taskId);
  expect(isCommandRefusal(after)).toBe(true);
  expect(codeOf(after as never)).toBe('SCOPE_NOT_GRANTED');
  expect(JSON.stringify(after)).not.toContain('"graph"');
  expect(JSON.stringify(after)).not.toContain(String(work.picked['runId']));
});
