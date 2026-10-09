// SPDX-License-Identifier: AGPL-3.0-only
// P19 served execution reads. Synthetic event bulk is fixture setup, not a workflow claim.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { answerAtTheStop, type StopContext } from '../acceptance/stopped-run.ts';
import { agentPath, bearer, call, personPath } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  applied,
  auditCount,
  executionOf,
  openServedWorld,
  pickup,
  proposal,
  reach,
  reader,
  records,
  seed201,
  task,
  witness,
  work,
  type ServedWorld,
} from './p18-p19-served-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('P19 served proof: no DATABASE_URL; nothing proved.');

const live = describe.skipIf(serverUrl === undefined);
let s: ServedWorld;
beforeAll(async () => {
  s = await openServedWorld('p19_execution_served');
}, 180_000);
afterAll(async () => {
  await s?.close();
});

live('P19 truthful task execution over served API', () => {
  it('paginates 201 real task events as 200 plus 1 without duplicates or sibling events', async () => {
    const own = await work(s, 'P19 pagination own task');
    const sibling = await work(s, 'P19 hidden sibling task');
    await seed201(s, own.taskId, 'P19 own event canary');
    await seed201(s, sibling.taskId, 'P19 sibling event canary');
    const before = await records(s, own.taskId);
    const firstAnswer = await s.person(s.world.ada, 'task.execution', { recordId: own.taskId });
    const first = executionOf(firstAnswer);
    expect(first).toMatchObject({
      taskId: own.taskId,
      sourceRevision: 201,
      complete: false,
      next: 200,
    });
    expect(first.events).toHaveLength(200);
    const lastAnswer = await s.person(s.world.ada, 'task.execution', {
      recordId: own.taskId,
      cursor: first.next,
    });
    const last = executionOf(lastAnswer);
    expect(last).toMatchObject({
      taskId: own.taskId,
      sourceRevision: 201,
      complete: true,
      next: null,
    });
    expect(last.events).toHaveLength(1);
    const events = [...first.events, ...last.events];
    expect(events.map((event) => event.position)).toStrictEqual(
      Array.from({ length: 201 }, (_, i) => i + 1),
    );
    expect(new Set(events.map((event) => event.eventId)).size).toBe(201);
    expect(new Set(events.map((event) => event.runId))).toStrictEqual(
      new Set([own.picked['runId']]),
    );
    for (const text of [firstAnswer.text, lastAnswer.text]) {
      expect(text).not.toContain(sibling.taskId);
      expect(text).not.toContain(String(sibling.picked['runId']));
      expect(text).not.toContain('P19 sibling event canary');
    }
    expect(await records(s, own.taskId)).toStrictEqual(before);
  });
});

live('P19 truthful task execution over served API', () => {
  it('refuses a later real page after task-read revocation rather than disclosing or answering empty', async () => {
    const own = await work(s, 'P19 later-page task');
    const sibling = await work(s, 'P19 later-page sibling');
    await seed201(s, own.taskId, 'P19 denied event canary');
    const who = await reader(s, 'P19 paged reader');
    const grant = await reach(s, who, 'record', own.taskId);
    const first = executionOf(await s.person(who, 'task.execution', { recordId: own.taskId }));
    expect(first.events).toHaveLength(200);
    expect(first.next).toBe(200);
    await s.world.db.app.withBusiness(s.world.alpha, async (tx) => {
      expect(await revokeGrant(tx, grant)).not.toBeNull();
    });
    const audited = await auditCount(s, 'task.execution', 'refused');
    const refused = await s.person(who, 'task.execution', {
      recordId: own.taskId,
      cursor: first.next,
    });
    expect(refused.code).toBe('SCOPE_NOT_GRANTED');
    expect(refused.body['execution']).toBeUndefined();
    expect(refused.text).not.toContain('P19 denied event canary');
    expect(refused.text).not.toContain(String(own.picked['runId']));
    expect(refused.text).not.toContain(String(own.picked['leaseId']));
    expect(await auditCount(s, 'task.execution', 'refused')).toBe(audited + 1);
    const siblingOnly = await reader(s, 'P19 sibling-only reader');
    await reach(s, siblingOnly, 'record', sibling.taskId);
    expect(
      executionOf(await s.person(siblingOnly, 'task.execution', { recordId: sibling.taskId }))
        .taskId,
    ).toBe(sibling.taskId);
    expect((await s.person(siblingOnly, 'task.execution', { recordId: own.taskId })).code).toBe(
      'SCOPE_NOT_GRANTED',
    );
    const foreign = await s.person(s.world.bea, 'task.execution', { recordId: own.taskId });
    expect(foreign.code).toBe('NOT_FOUND');
    expect(foreign.text).not.toContain('P19 denied event canary');
  });
});

live('P19 truthful task execution over served API', () => {
  it('reports real planned, claimed, handed-back, budget-waiting, cancelled and idle states', async () => {
    const made = await task(s, 'P19 state lifecycle task');
    const before = await records(s, made.id);
    const planned = await proposal(s, made);
    const read = async () =>
      executionOf(await s.person(s.world.ada, 'task.execution', { recordId: made.id }));
    expect((await read()).runs[0]).toMatchObject({ runId: planned['runId'], state: 'planned' });
    const picked = await pickup(s, planned);
    expect((await read()).runs[0]).toMatchObject({ runId: picked['runId'], state: 'claimed' });
    applied(
      await s.agent(
        'task.handback',
        {
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
          report: { summary: 'synthetic work complete' },
          actualMinor: null,
        },
        String(picked['credential']),
      ),
    );
    const ended = await read();
    expect(ended.runs[0]).toMatchObject({
      state: 'handed_back',
      taskRevisionAtRequest: made.revision,
    });
    expect(ended.events.map((event) => event.kind)).toStrictEqual(['claimed', 'handed_back']);
    expect(ended).toMatchObject({ taskId: made.id, sourceRevision: 2, complete: true, next: null });
    expect(await records(s, made.id)).toStrictEqual(before);
    await budgetStop(s);
    const idle = await task(s, 'P19 genuine idle task');
    expect(
      executionOf(await s.person(s.world.ada, 'task.execution', { recordId: idle.id })),
    ).toMatchObject({
      taskId: idle.id,
      outcome: 'no-run',
      sourceRevision: 0,
      complete: true,
      next: null,
      runs: [],
      events: [],
    });
  });
});

live('P19 truthful task execution over served API', () => {
  it('keeps each answer attributable to its person/task across revocation and owner changes', async () => {
    const a = await work(s, 'P19 owner A task');
    const b = await work(s, 'P19 owner B task');
    const personA = await reader(s, 'P19 owner A');
    const personB = await reader(s, 'P19 owner B');
    const grantA = await reach(s, personA, 'record', a.taskId);
    await reach(s, personB, 'record', b.taskId);
    const beforeA = await records(s, a.taskId);
    const beforeB = await records(s, b.taskId);
    const appliedBefore = await auditCount(s, 'task.execution', 'applied');
    const refusedBefore = await auditCount(s, 'task.execution', 'refused');
    const held = await s.person(personA, 'task.execution', { recordId: a.taskId });
    expect(executionOf(held).taskId).toBe(a.taskId);
    await s.world.db.app.withBusiness(s.world.alpha, async (tx) => {
      expect(await revokeGrant(tx, grantA)).not.toBeNull();
    });
    const deniedA = await s.person(personA, 'task.execution', { recordId: a.taskId });
    expect(deniedA.code).toBe('SCOPE_NOT_GRANTED');
    const currentB = await s.person(personB, 'task.execution', { recordId: b.taskId });
    expect(executionOf(currentB).taskId).toBe(b.taskId);
    expect(currentB.text).not.toContain(a.taskId);
    expect(currentB.text).not.toContain(String(a.picked['runId']));
    const deniedB = await s.person(personB, 'task.execution', { recordId: a.taskId });
    expect(deniedB.code).toBe('SCOPE_NOT_GRANTED');
    expect(deniedB.body['execution']).toBeUndefined();
    expect(deniedB.text).not.toContain(String(a.picked['runId']));
    expect(executionOf(held).taskId).toBe(a.taskId);
    expect(await records(s, a.taskId)).toStrictEqual(beforeA);
    expect(await records(s, b.taskId)).toStrictEqual(beforeB);
    expect(await auditCount(s, 'task.execution', 'applied')).toBe(appliedBefore + 2);
    expect(await auditCount(s, 'task.execution', 'refused')).toBe(refusedBefore + 2);
  });
});

// The existing broker recipe creates the stop through the canonical in-process
// API, because serveApi deliberately mounts no model broker. Reads and the
// approver's ending command below cross the independent served HTTP process.
function budgetContext(proof: ServedWorld): StopContext {
  const fixtureCall = async (
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ) =>
    await call(
      proof.world.api,
      agentPath('alpha', pathOf(name)),
      { operationId: randomUUID(), ...body },
      {
        ...bearer(proof.world.agent.token),
        ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
      },
    );
  const personCall = async (name: CommandName, body: Readonly<Record<string, unknown>>) =>
    await call(
      proof.world.api,
      personPath('alpha', pathOf(name)),
      { operationId: randomUUID(), ...body },
      bearer(proof.world.ada.token),
    );
  return {
    asPerson: personCall,
    asAgent: fixtureCall,
    freshTask: async (title) => {
      const made = applied(await personCall('task.create', { fields: { title } }));
      return { id: String(made['recordId']), revision: Number(made['revision']) };
    },
  };
}

async function budgetStop(proof: ServedWorld): Promise<void> {
  const seen = proof.world.broker.provider.seen.length;
  const stopped = await answerAtTheStop(budgetContext(proof), 'run.end_at_budget_stop', {
    purpose: `p19_budget_${randomUUID().replaceAll('-', '_')}`,
    currency: 'AUD',
    payload: { instruction: 'synthetic budget stop' },
    step: { kind: 'compose', payload: {} },
  });
  if (!('body' in stopped)) throw new Error(stopped.exception);
  expect(proof.world.broker.provider.seen.length).toBe(seen);
  const recordId = String(stopped.body['recordId']);
  witness({
    kind: 'budget-stop',
    recordId,
    runId: stopped.body['runId'],
    providerRequestsBefore: seen,
    providerRequestsAfter: proof.world.broker.provider.seen.length,
  });
  const waiting = executionOf(await proof.person(proof.world.ada, 'task.execution', { recordId }));
  expect(waiting.runs).toContainEqual(
    expect.objectContaining({ runId: stopped.body['runId'], state: 'waiting_budget' }),
  );
  applied(await proof.person(proof.world.ada, 'run.end_at_budget_stop', stopped.body));
  const cancelled = executionOf(
    await proof.person(proof.world.ada, 'task.execution', { recordId }),
  );
  expect(cancelled.runs).toContainEqual(
    expect.objectContaining({ runId: stopped.body['runId'], state: 'cancelled' }),
  );
}
