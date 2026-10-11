// SPDX-License-Identifier: AGPL-3.0-only
//
// Four eyes holds against the person accountable for an agent's proposal. A
// launches B's agent; the agent proposes under the delegation A's Launch
// minted, so A is that delegation's person. A is not offered the decision
// and is refused it, as B (the agent's owner) is. The rule is on the proposal,
// so it stands after A's launch ends and B launches again. A third person
// decides. A pickup's delegation is not a Launch's: its person approved the
// run and still reviews what the agent proposes under it (AW-09). Asked of
// the task without a gate, as the board asks, a lapsed gate beside the one A
// launched leaves A nothing to decide, so the board shows A none.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import {
  agentProposes,
  aiWorld,
  assign,
  created,
  decide,
  launch,
  offeredTo,
  revisionOf,
  type AiWorld,
  type Gate,
} from './ai-assign-world.ts';

const APPLIED = 'not-a-refusal';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('four-eyes-excludes-the-launcher: DATABASE_URL is unset.');

let w: AiWorld;
/** Holds every task permission and `agent:assign`: launches agents other people own. */
let a: Decider;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await aiWorld('foureyeslaunch');
  const member = await enrol(w.world.db.app, w.world.business, 'launcher');
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    for (const action of ['read', 'write', 'comment', 'assign', 'decide'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- five grants
      await grantTo(tx, member, action);
    }
    await grantTo(tx, member, 'assign', undefined, false, 'agent');
  });
  a = member as Decider;
  // The world's signed-in agent is B's (w.q).
  await w.world.db.admin.execute(`update public.actors set owner_person_id = $1 where id = $2`, [
    w.q.personId,
    w.world.agentActorId,
  ]);
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** Whether `task.board` marks the task as awaiting this reader's decision. */
async function awaitsOnBoard(by: Decider, taskId: string): Promise<boolean | undefined> {
  const answer = await executeRead(w.world.db.app, w.world.business, by.presented, {
    read: 'task.board',
    board: null,
  });
  if (isCommandRefusal(answer) || !('tasks' in answer)) throw new Error('task.board refused');
  const rows = answer.tasks as unknown as readonly { id: string; awaitingDecision: boolean }[];
  return rows.find((row) => row.id === taskId)?.awaitingDecision;
}

describe.skipIf(serverUrl === undefined)(
  'Four eyes excludes the person who launched the agent',
  () => {
    it('the launcher is not offered the decision and is refused it, as the owner is', async () => {
      const task = await created(w, w.q, 'Launched by someone else');
      expect(codeOf(await assign(w, w.q, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
      expect(await launch(w, a, task)).toBe(APPLIED);
      const gate = await agentProposes(w, task);
      const offered = await offeredTo(w, gate.gateId);
      expect(offered).toContain(w.p.personId);
      expect(offered).not.toContain(a.personId);
      expect(offered).not.toContain(w.q.personId);
      expect(await decide(w, a, gate)).toBe('FOUR_EYES_REQUIRED');
      expect(await decide(w, w.q, gate)).toBe('FOUR_EYES_REQUIRED');
      expect(await awaitsOnBoard(a, task)).toBe(false);
    });

    it('the proposal keeps its launcher out after the launch ends and the owner launches again', async () => {
      const task = await created(w, w.q, 'Launched twice');
      expect(codeOf(await assign(w, w.q, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
      expect(await launch(w, a, task)).toBe(APPLIED);
      const gate = await agentProposes(w, task);
      await w.world.db.admin.execute(
        `update public.delegations set granted_at = now() - interval '9 hours',
              expires_at = now() - interval '1 hour'
        where purpose_scope_id = $1`,
        [task],
      );
      expect(await launch(w, w.q, task)).toBe(APPLIED);
      expect(await offeredTo(w, gate.gateId)).not.toContain(a.personId);
      expect(await decide(w, a, gate)).toBe('FOUR_EYES_REQUIRED');
      expect(await decide(w, w.p, gate)).toBe(APPLIED);
    });

    it("a pickup's person still reviews what the agent proposes under it", async () => {
      const picked = await w.world.pickUp(w.p, 'Picked up after approval');
      // Room in the task's envelope beside the run's hold: setup, not the path under test.
      await w.world.db.admin.execute(
        `update public.task_envelopes set maximum_minor = maximum_minor * 2 where task_id = $1`,
        [picked.taskId],
      );
      const gate = await agentProposes(w, picked.taskId, picked.credential);
      expect(await offeredTo(w, gate.gateId)).toContain(w.p.personId);
      expect(await decide(w, w.p, gate)).toBe(APPLIED);
    });
  },
);

describe.skipIf(serverUrl === undefined)("The board reads the launcher's exclusion", () => {
  it('the board does not show the launcher a task whose only live gate they launched', async () => {
    const task = await created(w, w.q, 'A lapsed gate beside the launched one');
    const lapsed = await w.world.asPerson(w.q, {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await revisionOf(w, task),
      purpose: `gate_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    });
    if (isCommandRefusal(lapsed)) throw new Error(`task.propose refused ${lapsed.code}`);
    await w.world.db.admin.execute(
      `update public.gates set expires_at = now() - interval '1 minute' where id = $1`,
      [(lapsed.detail as Gate).gateId],
    );
    expect(codeOf(await assign(w, w.q, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
    expect(await launch(w, a, task)).toBe(APPLIED);
    const gate = await agentProposes(w, task);
    expect(await decide(w, a, gate)).toBe('FOUR_EYES_REQUIRED');
    expect(await awaitsOnBoard(a, task)).toBe(false);
    expect(await awaitsOnBoard(w.p, task)).toBe(true);
  });
});
