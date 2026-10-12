// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's field write (`task.set_scores`) asks its delegation and the
// delegating person's write grant again under the task's lock. A write grant
// that expires while the write waits for the task row refuses it and keeps
// nothing. A `delegation.revoke` queued behind the same row takes the task
// before the delegation, so it neither deadlocks with the write's `for share`
// on the delegation nor overtakes it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { enrol, grantTo } from './fixture.ts';

let world: AgentWorld;

beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) throw new Error('This proof requires Postgres.');
  world = await agentWorld('agent_task_wait', `atw-${randomUUID().slice(0, 8)}`);
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

async function revisionOf(taskId: string): Promise<string | undefined> {
  const [row] = await world.db.admin.execute<{ revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.business, taskId],
  );
  return row?.revision;
}

async function appliedFor(operationId: string): Promise<number | undefined> {
  const [events] = await world.db.admin.execute<{ applied: number }>(
    `select count(*)::int as applied from public.audit_events
      where business_id = $1 and operation_id = $2 and outcome = 'applied'`,
    [world.business, operationId],
  );
  return events?.applied;
}

async function holdTask(taskId: string): ReturnType<typeof hold> {
  return await hold(world.db.appUrl, world.business, async (tx) => {
    await tx.query('select id from public.records where business_id = $1 and id = $2 for update', [
      world.business,
      taskId,
    ]);
  });
}

it('an agent field write keeps nothing when its write grant expires during the task lock wait', async () => {
  const writer = await world.decider(`writer_${randomUUID()}`);
  const picked = await world.pickUp(writer, 'Scores across the task wait');
  const before = await revisionOf(picked.taskId);
  const operationId = randomUUID();
  const held = await holdTask(picked.taskId);
  let writing: ReturnType<AgentWorld['asAgent']> | undefined;
  try {
    writing = world.asAgent(
      {
        command: 'task.set_scores',
        operationId,
        recordId: picked.taskId,
        expectedRevision: Number(before),
        fields: { impact: 4, confidence: 5, ease: 6 },
      },
      picked.credential,
    );
    await waitingOn(world.db.admin, 'transactionid', 'from records');
    await world.db.admin.execute(
      'update public.grants set expires_at = clock_timestamp() where id = $1',
      [writer.grants.write],
    );
  } finally {
    await held.letGo();
  }
  const answer = await writing;
  if (answer === undefined) throw new Error('No agent answer');
  expect({
    code: codeOf(answer),
    revisionMoved: (await revisionOf(picked.taskId)) !== before,
    applied: await appliedFor(operationId),
  }).toEqual({ code: 'DELEGATION_NARROWED', revisionMoved: false, applied: 0 });
}, 60_000);

it('an agent field write and a delegation revoke queued behind its task row both finish, in that order', async () => {
  const writer = await world.decider(`writer_${randomUUID()}`);
  const picked = await world.pickUp(writer, 'Scores beside a revoke');
  const before = await revisionOf(picked.taskId);
  const manager = await enrol(world.db.app, world.business, `manager_${randomUUID()}`);
  await world.db.app.withBusiness(world.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'comment', 'manage'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time on one transaction
      await grantTo(tx, manager, action);
    }
  });
  const revoker = connect(world.db.appUrl);
  const operationId = randomUUID();
  const held = await holdTask(picked.taskId);
  let writing: ReturnType<AgentWorld['asAgent']> | undefined;
  let revoking: ReturnType<typeof executeCommand> | undefined;
  try {
    writing = world.asAgent(
      {
        command: 'task.set_scores',
        operationId,
        recordId: picked.taskId,
        expectedRevision: Number(before),
        fields: { impact: 4, confidence: 5, ease: 6 },
      },
      picked.credential,
    );
    await waitingOn(world.db.admin, 'transactionid', 'from records');
    // `delegation.revoke` locks the task before the delegation (the global
    // order), so it queues behind the write rather than holding the
    // delegation the write's `askedAgain` then shares.
    revoking = executeCommand(revoker, world.business, manager.presented, 'api', {
      command: 'delegation.revoke',
      operationId: randomUUID(),
      delegationId: String(picked.detail['delegationId']),
    });
    await waitingOn(world.db.admin, 'tuple', 'from public.records');
  } finally {
    await held.letGo();
  }
  const [answer, revoked] = await Promise.all([writing, revoking]);
  await revoker.close();
  if (answer === undefined || revoked === undefined) throw new Error('No answer');
  expect({
    write: codeOf(answer),
    revoke: codeOf(revoked),
    revisionMoved: (await revisionOf(picked.taskId)) !== before,
    applied: await appliedFor(operationId),
  }).toEqual({ write: 'not-a-refusal', revoke: 'not-a-refusal', revisionMoved: true, applied: 1 });
}, 60_000);
