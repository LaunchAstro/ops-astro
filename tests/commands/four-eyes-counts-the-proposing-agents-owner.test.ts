// SPDX-License-Identifier: AGPL-3.0-only
//
// Four eyes counts an agent's work as its owner's, whoever holds the task
// now (#1247). P owns the world's agent and holds every task permission; L
// launches it on P's task and it proposes under L's Launch. P then hands the
// task to Q, or to Q's agent. P is still refused the gate and raised no
// decision item for it; R, who neither owns, launched nor holds the task,
// decides it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import {
  agentProposes,
  aiWorld,
  assign,
  created,
  decide,
  directsEvery,
  launch,
  offeredTo,
  ownedAgent,
  type AiWorld,
  type Gate,
} from './ai-assign-world.ts';

const APPLIED = 'not-a-refusal';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('four-eyes-counts-the-proposing-agents-owner: DATABASE_URL is unset.');

let w: AiWorld;
/** Launches the agent P owns: holds every task permission and `agent:assign`. */
let l: Decider;
/** A third person with decide: owns no agent here and launches nothing. */
let r: Decider;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await aiWorld('foureyesowner');
  const member = await enrol(w.world.db.app, w.world.business, 'launcher');
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    for (const action of ['read', 'write', 'comment', 'assign', 'decide'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- five grants
      await grantTo(tx, member, action);
    }
    await grantTo(tx, member, 'assign', undefined, false, 'agent');
  });
  l = member as Decider;
  r = await w.world.decider('r');
  await directsEvery(w, w.p);
  await w.world.db.admin.execute(`update public.actors set owner_person_id = $1 where id = $2`, [
    w.p.personId,
    w.world.agentActorId,
  ]);
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** P's task, held by P's agent, with the gate it proposed under L's Launch. */
async function proposedByPsAgent(title: string): Promise<{ task: string; gate: Gate }> {
  const task = await created(w, w.p, title);
  expect(codeOf(await assign(w, w.p, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
  expect(await launch(w, l, task)).toBe(APPLIED);
  const gate = await agentProposes(w, task);
  expect(await decide(w, w.p, gate)).toBe('FOUR_EYES_REQUIRED');
  return { task, gate };
}

describe.skipIf(serverUrl === undefined)(
  "Four eyes counts the proposing agent's work as its owner's",
  () => {
    it("the owner is still refused their agent's proposal after handing the task to a person", async () => {
      const { task, gate } = await proposedByPsAgent('Handed to a person');
      expect(codeOf(await assign(w, w.p, task, { assignee: w.q.personId }))).toBe(APPLIED);
      expect(await offeredTo(w, gate.gateId)).not.toContain(w.p.personId);
      expect(await decide(w, w.p, gate)).toBe('FOUR_EYES_REQUIRED');
      expect(await decide(w, r, gate)).toBe(APPLIED);
    });

    it("the owner is still refused their agent's proposal after handing the task to another agent", async () => {
      const { task, gate } = await proposedByPsAgent('Handed to another agent');
      const qsAgent = await ownedAgent(w, w.q);
      expect(codeOf(await assign(w, w.p, task, { agent: qsAgent }))).toBe(APPLIED);
      expect(await offeredTo(w, gate.gateId)).not.toContain(w.p.personId);
      expect(await decide(w, w.p, gate)).toBe('FOUR_EYES_REQUIRED');
      expect(await decide(w, r, gate)).toBe(APPLIED);
    });
  },
);
