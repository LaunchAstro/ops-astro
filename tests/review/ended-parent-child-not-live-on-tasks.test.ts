// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #413, the same root cause beyond Access: a child delegation whose
// parent has ended is refused at each call by `checkDelegatedAuthority`, so the
// task and board reads never show the child's agent live on its task. The
// agent still holds the task: an assignment is no delegation's to end.
import { expect, it as vitestIt } from 'vitest';
import { readBoardAgents } from '../../packages/core-commands/src/reads/board-agents.ts';
import { readTaskAgents } from '../../packages/core-commands/src/reads/task-agents.ts';
import { revokeDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { child, noDatabase, parentWork, useChildWorld, w } from '../runtime/aw-11-child-world.ts';

useChildWorld('endedparent413');
const it = noDatabase ? vitestIt.skip : vitestIt;

/** Work with its parent and a child, the child's agent holding the task, then the parent revoked. */
async function deadChild(): Promise<{ readonly taskId: string; readonly agentId: string }> {
  const { parent } = await parentWork(w.s);
  const minted = await child(w.s, parent, w.helper);
  const taskId = parent.purposeScope.id;
  const agentId = minted.delegation.agentActorId;
  await w.s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('agent', $1::text)
      where business_id = $2 and id = $3`,
    [agentId, w.s.business, taskId],
  );
  const live = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await readTaskAgents(tx, taskId, w.s.decider.personId),
  );
  expect(live.agent).toMatchObject({ agentId, live: true });
  await w.s.db.app.withBusiness(w.s.business, async (tx) => await revokeDelegation(tx, parent.id));
  return { taskId, agentId };
}

it('the task read shows the agent of a child whose parent was revoked holding the task, not live', async () => {
  const { taskId, agentId } = await deadChild();
  const read = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await readTaskAgents(tx, taskId, w.s.decider.personId),
  );
  expect(read.agent).toMatchObject({ agentId, live: false });
});

it('the board shows the agent of a child whose parent was revoked holding the task, not live', async () => {
  const { taskId, agentId } = await deadChild();
  const rows = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await readBoardAgents(tx, [taskId], w.s.decider.personId, null),
  );
  expect(rows.get(taskId)?.agent).toMatchObject({ agentId, live: false });
});
