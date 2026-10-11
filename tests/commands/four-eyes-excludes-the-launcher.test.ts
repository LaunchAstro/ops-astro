// SPDX-License-Identifier: AGPL-3.0-only
//
// Four eyes holds against the person accountable for an agent's proposal. A
// launches B's agent; the agent proposes under the delegation A's Launch
// minted, so A is that delegation's person. A is not offered the decision
// and is refused it, as B (the agent's owner) is. The rule is on the proposal,
// so it stands after A's launch ends and B launches again. A third person
// decides. A pickup's delegation is not a Launch's: its person approved the
// run and still reviews what the agent proposes under it (AW-09).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { configuredCredentialKeys } from '../../packages/core-records/src/index.ts';
import { codeOf, type Decider } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import { aiWorld, assign, created, revisionOf, type AiWorld } from './ai-assign-world.ts';

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

const launch = async (by: Decider, taskId: string): Promise<string> =>
  codeOf(
    await w.world.asPerson(by, {
      command: 'task.launch',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(w, taskId),
    }),
  );

/** The credential the runner is handed for the task's waiting launch, derived as the API derives it. */
async function credentialFor(taskId: string): Promise<string> {
  const [row] = await w.world.db.admin.execute<{ readonly id: string; readonly key: string }>(
    `select d.id, d.credential_key_id as key
       from public.task_launches l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.task_id = $1 and l.state = 'waiting'`,
    [taskId],
  );
  const keys = configuredCredentialKeys();
  if (row === undefined || !keys.ok) throw new Error('fixture: no launch to derive from');
  const credential = keys.keys.derive(row.key, {
    businessId: w.world.business,
    agentActorId: w.world.agentActorId,
    delegationId: row.id,
  });
  if (credential === undefined) throw new Error('fixture: the key is not held');
  return credential;
}

/** The agent's proposal on the task, under the launch's delegation unless another credential is named. */
async function agentProposes(
  taskId: string,
  credential?: string,
): Promise<{ gateId: string; versionId: string }> {
  const answer = await w.world.asAgent(
    {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(w, taskId),
      purpose: `gate_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    },
    credential ?? (await credentialFor(taskId)),
  );
  if (isCommandRefusal(answer)) throw new Error(`task.propose refused ${answer.code}`);
  return answer.detail as { gateId: string; versionId: string };
}

const decide = async (by: Decider, gate: { gateId: string; versionId: string }) =>
  codeOf(
    await w.world.asPerson(by, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: gate.gateId,
      versionId: gate.versionId,
      decision: 'approve',
      note: 'a second person decides',
    }),
  );

/** Who holds an open decision item on the gate. */
const offeredTo = async (gateId: string): Promise<readonly string[]> =>
  (
    await w.world.db.admin.execute<{ readonly person: string }>(
      `select recipient_person_id::text as person from public.inbox_items
        where reason = 'decision' and fact_kind = 'gate' and fact_id = $1 and work_state = 'open'`,
      [gateId],
    )
  ).map((row) => row.person);

describe.skipIf(serverUrl === undefined)(
  'Four eyes excludes the person who launched the agent',
  () => {
    it('the launcher is not offered the decision and is refused it, as the owner is', async () => {
      const task = await created(w, w.q, 'Launched by someone else');
      expect(codeOf(await assign(w, w.q, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
      expect(await launch(a, task)).toBe(APPLIED);
      const gate = await agentProposes(task);
      const offered = await offeredTo(gate.gateId);
      expect(offered).toContain(w.p.personId);
      expect(offered).not.toContain(a.personId);
      expect(offered).not.toContain(w.q.personId);
      expect(await decide(a, gate)).toBe('FOUR_EYES_REQUIRED');
      expect(await decide(w.q, gate)).toBe('FOUR_EYES_REQUIRED');
    });

    it('the proposal keeps its launcher out after the launch ends and the owner launches again', async () => {
      const task = await created(w, w.q, 'Launched twice');
      expect(codeOf(await assign(w, w.q, task, { agent: w.world.agentActorId }))).toBe(APPLIED);
      expect(await launch(a, task)).toBe(APPLIED);
      const gate = await agentProposes(task);
      await w.world.db.admin.execute(
        `update public.delegations set granted_at = now() - interval '9 hours',
              expires_at = now() - interval '1 hour'
        where purpose_scope_id = $1`,
        [task],
      );
      expect(await launch(w.q, task)).toBe(APPLIED);
      expect(await offeredTo(gate.gateId)).not.toContain(a.personId);
      expect(await decide(a, gate)).toBe('FOUR_EYES_REQUIRED');
      expect(await decide(w.p, gate)).toBe(APPLIED);
    });

    it("a pickup's person still reviews what the agent proposes under it", async () => {
      const picked = await w.world.pickUp(w.p, 'Picked up after approval');
      // Room in the task's envelope beside the run's hold: setup, not the path under test.
      await w.world.db.admin.execute(
        `update public.task_envelopes set maximum_minor = maximum_minor * 2 where task_id = $1`,
        [picked.taskId],
      );
      const gate = await agentProposes(picked.taskId, picked.credential);
      expect(await offeredTo(gate.gateId)).toContain(w.p.personId);
      expect(await decide(w.p, gate)).toBe(APPLIED);
    });
  },
);
