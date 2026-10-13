// SPDX-License-Identifier: AGPL-3.0-only
//
// A take asked again under the same operation id answers about what it first
// answered: an empty take stays empty though a launch was made since, and a
// replayed take keeps its task as the audit subject. A write under a launch's
// credential that was waiting on the task's lock when a take started that
// launch is refused once it gets the lock, and writes nothing. A take that
// presents a delegation credential is refused on its replay as on a fresh
// call, and a write under a waiting launch takes the cap before the task, as
// every other holder of both does, so it waits rather than deadlocks.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { hold, holdRow, waiterOf } from '../support/lock-wait-race.ts';
import { aiWorld, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { APPLIED, derivedFor, launchOf, launchedTask, takenAs } from './take-launch-world.ts';

let w: AiWorld;
beforeAll(async () => {
  w = await aiWorld('takereplay');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

it('an empty take asked again answers none and starts no launch made since', async () => {
  const request = { command: 'task.take_launch', operationId: randomUUID() };
  const first = await w.world.asAgent(request);
  expect(codeOf(first)).toBe(APPLIED);
  expect(takenAs(first)).toEqual({ state: 'none' });
  const task = await launchedTask(w, 'Work appearing after the original take');
  const launched = await launchOf(w, task);
  expect(launched.state).toBe('waiting');
  const repeated = await w.world.asAgent(request);
  const after = await launchOf(w, task);
  expect({ reply: takenAs(repeated), state: after.state, takenAt: after.takenAt }).toEqual({
    reply: { state: 'none' },
    state: 'waiting',
    takenAt: null,
  });
});

it('a comment waiting for its task cannot write once that launch is taken', async () => {
  const task = await launchedTask(w, 'The launch closes direct writing');
  const launched = await launchOf(w, task);
  const credential = await derivedFor(w, launched.id);
  const held = await holdRow(w.world.db, 'select 1 from public.records where id = $1 for share', [
    task,
  ]);
  const other = connect(w.world.db.appUrl);
  let comment;
  try {
    const writing = w.world.asAgent(
      {
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: task,
        body: 'A direct write after the take',
        audience: 'internal',
      },
      credential,
    );
    await waiterOf(w.world.db, held);
    const taken = await executeAgentCommand(
      other,
      w.world.business,
      { provider: 'supabase', subject: w.world.agentSubject() },
      undefined,
      { command: 'task.take_launch', operationId: randomUUID(), launchId: launched.id },
    );
    expect(codeOf(taken)).toBe(APPLIED);
    expect((await launchOf(w, task)).state).toBe('started');
    await held.letGo();
    comment = await writing;
  } finally {
    await held.letGo();
    await other.close();
  }
  const [row] = await w.world.db.admin.execute<{ n: number }>(
    "select count(*)::int as n from public.records where data->>'task' = $1",
    [task],
  );
  expect({ code: codeOf(comment), comments: row?.n }).toEqual({
    code: 'DELEGATION_EXCLUDES_OPERATION',
    comments: 0,
  });
}, 30_000);

it('a replayed take keeps its task in the audit chain', async () => {
  const task = await launchedTask(w, 'An attributable take replay');
  const launched = await launchOf(w, task);
  const request = { command: 'task.take_launch', operationId: randomUUID(), launchId: launched.id };
  expect(codeOf(await w.world.asAgent(request))).toBe(APPLIED);
  expect(codeOf(await w.world.asAgent(request))).toBe(APPLIED);
  const rows = await w.world.db.admin.execute<{ outcome: string; subject: string | null }>(
    'select outcome, subject_record_id::text as subject from public.audit_events where operation_id = $1 order by seq',
    [request.operationId],
  );
  expect(rows).toEqual([
    { outcome: 'applied', subject: task },
    { outcome: 'replayed', subject: task },
  ]);
});

it('an empty take asked again with a credential is refused as a fresh one is', async () => {
  const own = await aiWorld('takereplaycredential');
  try {
    const request = { command: 'task.take_launch', operationId: randomUUID() };
    expect(takenAs(await own.world.asAgent(request))).toEqual({ state: 'none' });
    // The credential travels beside the request, outside its digest, so the
    // replay must judge it again. One that resolves to nothing is refused too.
    const credential = `synthetic-${randomUUID()}`;
    const fresh = await own.world.asAgent({ ...request, operationId: randomUUID() }, credential);
    expect(codeOf(fresh)).toBe('SCOPE_NOT_GRANTED');
    const repeated = await own.world.asAgent(request, credential);
    expect(codeOf(repeated)).toBe('SCOPE_NOT_GRANTED');
    const rows = await own.world.db.admin.execute<{ outcome: string; code: string | null }>(
      'select outcome, refusal_code as code from public.audit_events where operation_id = $1 order by seq',
      [request.operationId],
    );
    expect(rows).toEqual([
      { outcome: 'applied', code: null },
      { outcome: 'refused', code: 'SCOPE_NOT_GRANTED' },
    ]);
  } finally {
    await own.world.drop();
  }
}, 180_000);

it('a take asked again with no launch named stays on its first launch once that ends', async () => {
  const own = await aiWorld('takereplayended');
  try {
    const task = await launchedTask(own, 'The launch first taken');
    const firstLaunch = await launchOf(own, task);
    const request = { command: 'task.take_launch', operationId: randomUUID() };
    expect(codeOf(await own.world.asAgent(request))).toBe(APPLIED);
    await own.world.db.admin.execute(
      'update public.delegations set revoked_at = clock_timestamp() where id = $1',
      [firstLaunch.delegationId],
    );
    const ended = await own.world.asAgent({
      ...request,
      operationId: randomUUID(),
      launchId: firstLaunch.id,
    });
    const endedAs = { launchId: firstLaunch.id, state: 'ended', cause: 'revoked' };
    expect(takenAs(ended)).toMatchObject(endedAs);
    const laterTask = await launchedTask(own, 'A later waiting launch');
    expect(takenAs(await own.world.asAgent(request))).toMatchObject(endedAs);
    expect(await launchOf(own, laterTask)).toMatchObject({ state: 'waiting', takenAt: null });
  } finally {
    await own.world.drop();
  }
}, 180_000);

const deadlocksIn = async (own: AiWorld): Promise<number> => {
  const [row] = await own.world.db.admin.execute<{ n: number }>(
    'select deadlocks::int as n from pg_stat_database where datname = current_database()',
  );
  return row?.n ?? 0;
};

/** Cap, then task: the order a proposal, a handback and the runtime's `acquire` take them in. */
const holdCapThenTask = async (own: AiWorld, task: string) =>
  await hold(
    own.world.db,
    async (execute) => {
      await execute('select 1 from public.budget_caps where business_id = $1 for update', [
        own.world.business,
      ]);
    },
    async (execute) => {
      await execute('select 1 from public.records where business_id = $1 and id = $2 for update', [
        own.world.business,
        task,
      ]);
    },
  );

const proposeUnder = async (own: AiWorld, task: string, credential: string) =>
  await own.world.asAgent(
    {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await revisionOf(own, task),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3000,
      currency: 'AUD',
      payload: { instruction: 'a synthetic draft' },
      step: { kind: 'compose', payload: {} },
    },
    credential,
  );

it('a proposal under a waiting launch waits behind a cap holder and does not deadlock', async () => {
  const own = await aiWorld('takecaporder');
  try {
    const task = await launchedTask(own, 'A waiting launch proposes under its own authority');
    const credential = await derivedFor(own, (await launchOf(own, task)).id);
    const before = await deadlocksIn(own);
    const held = await holdCapThenTask(own, task);
    const writing = proposeUnder(own, task, credential).then(
      (result) => codeOf(result),
      () => 'raised',
    );
    try {
      await waiterOf(own.world.db, held);
    } finally {
      await held.letGo();
      await writing;
    }
    // Statistics publish when a backend ends: close the pools, then read afresh.
    await own.world.db.closeSessions();
    await own.world.db.admin.execute('select pg_stat_clear_snapshot()');
    expect(await deadlocksIn(own)).toBe(before);
    expect(await writing).toBe(APPLIED);
  } finally {
    await own.world.drop();
  }
}, 180_000);
