// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #413, the same root cause beyond Access: a child delegation whose
// parent has ended is refused at each call by `checkDelegatedAuthority`, so the
// task and board reads never offer it, never show it live, and `task.assign`
// refuses it.
import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { readBoardAgents } from '../../packages/core-commands/src/reads/board-agents.ts';
import { readTaskAgents } from '../../packages/core-commands/src/reads/task-agents.ts';
import { revokeDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { child, noDatabase, parentWork, useChildWorld, w } from '../runtime/aw-11-child-world.ts';

useChildWorld('endedparent413');
const it = noDatabase ? vitestIt.skip : vitestIt;

/** Work with its parent and a child for the decider, then the parent revoked. */
async function deadChild(): Promise<{ readonly taskId: string; readonly childId: string }> {
  const { parent } = await parentWork(w.s);
  const minted = await child(w.s, parent, w.helper);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => await revokeDelegation(tx, parent.id));
  return { taskId: parent.purposeScope.id, childId: minted.delegation.id };
}

const hold = async (taskId: string, delegationId: string): Promise<void> => {
  await w.s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('agent', $1::text)
      where business_id = $2 and id = $3`,
    [delegationId, w.s.business, taskId],
  );
};

it('the task read neither offers nor shows live a child whose parent was revoked', async () => {
  const { taskId, childId } = await deadChild();
  await hold(taskId, childId);
  const read = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await readTaskAgents(tx, taskId, w.s.decider.personId),
  );
  expect(read.myAgents.map((one) => one.delegationId)).not.toContain(childId);
  expect(read.agent).toMatchObject({ delegationId: childId, live: false });
});

it('the board neither offers nor shows live a child whose parent was revoked', async () => {
  const { taskId, childId } = await deadChild();
  await hold(taskId, childId);
  const rows = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await readBoardAgents(tx, [taskId], w.s.decider.personId),
  );
  const row = rows.get(taskId);
  expect((row?.myAgents ?? []).map((one) => one.delegationId)).not.toContain(childId);
  expect(row?.agent).toMatchObject({ delegationId: childId, live: false });
});

it('task.assign refuses a child whose parent was revoked', async () => {
  const { taskId, childId } = await deadChild();
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, w.s.decider, 'assign');
  });
  const revision = await w.s.db.admin.execute<{ readonly revision: number }>(
    'select revision from public.records where business_id = $1 and id = $2',
    [w.s.business, taskId],
  );
  const result = await executeCommand(w.s.db.app, w.s.business, w.s.decider.presented, 'api', {
    command: 'task.assign',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: Number(revision[0]?.revision),
    fields: { agent: childId },
  });
  expect(codeOf(result)).toBe('DELEGATION_NOT_LIVE');
});
