// SPDX-License-Identifier: AGPL-3.0-only
//
// A take asked again under the same operation id answers about what it first
// answered: an empty take stays empty though a launch was made since, and a
// replayed take keeps its task as the audit subject. A write under a launch's
// credential that was waiting on the task's lock when a take started that
// launch is refused once it gets the lock, and writes nothing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { holdRow, waiterOf } from '../support/lock-wait-race.ts';
import { aiWorld, type AiWorld } from './ai-assign-world.ts';
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
