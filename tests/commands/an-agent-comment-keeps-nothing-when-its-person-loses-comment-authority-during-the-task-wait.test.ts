// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's `task.comment` asks its delegating person's comment grant again
// under the task's lock (#1009): a `grant.revoke` that commits while the
// comment waits for the task row leaves no comment and no applied event.
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
  world = await agentWorld('sol1475_comment', `sol-${randomUUID().slice(0, 8)}`);
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

// oxlint-disable-next-line max-lines-per-function -- one race, set up and judged in order
it('an agent comment keeps nothing when its person loses comment authority during the task lock wait', async () => {
  const writer = await world.decider(`writer_${randomUUID()}`);
  const picked = await world.pickUp(writer, 'Revoked comment authority');
  const manager = await enrol(world.db.app, world.business, `manager_${randomUUID()}`);
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, manager, 'manage');
    await grantTo(tx, manager, 'comment');
  });
  const revoker = connect(world.db.appUrl);
  const operationId = randomUUID();
  const held = await hold(world.db.appUrl, world.business, async (tx) => {
    await tx.query('select id from public.records where business_id = $1 and id = $2 for update', [
      world.business,
      picked.taskId,
    ]);
  });
  let posting: ReturnType<AgentWorld['asAgent']> | undefined;
  try {
    posting = world.asAgent(
      {
        command: 'task.comment',
        operationId,
        recordId: picked.taskId,
        audience: 'internal',
        body: 'Must not land after revocation',
      },
      picked.credential,
    );
    await waitingOn(world.db.admin, 'transactionid', 'from records');
    const revoked = await executeCommand(revoker, world.business, manager.presented, 'api', {
      command: 'grant.revoke',
      operationId: randomUUID(),
      grantId: writer.grants.comment,
    });
    expect(codeOf(revoked)).toBe('not-a-refusal');
  } finally {
    await held.letGo();
    await revoker.close();
  }
  const answer = await posting;
  if (answer === undefined) throw new Error('No agent answer');
  const [events] = await world.db.admin.execute<{ applied: number }>(
    `select count(*)::int as applied from public.audit_events
      where business_id = $1 and operation_id = $2 and outcome = 'applied'`,
    [world.business, operationId],
  );
  expect({
    code: codeOf(answer),
    comments: await world.commentsOn(picked.taskId),
    applied: events?.applied,
  }).toEqual({ code: 'DELEGATION_NARROWED', comments: 0, applied: 0 });
}, 30_000);
