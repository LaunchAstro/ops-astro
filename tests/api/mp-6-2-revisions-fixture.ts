// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2, the world the `state revised` tests share, `run-write-isolation`'s:
// A's agent carries `run:write` from the manager who approved its run; the
// writer holds no run grant at all, and B's agent works task B, which the
// writer approved, so B's delegation carries no `run:write`. Bravo is a second
// business with its own spine.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { agentPath, detailOf, type Controls } from './controls-fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';

export const REVISIONS = `select count(*)::text as n from public.run_state_revisions where task_id = $1`;

export interface RevisionRead {
  readonly version: number;
  readonly step: string | null;
  readonly valid: readonly { k: string; v: string }[];
  readonly unknowns: readonly string[];
  readonly stale: readonly { k: string; why: string }[];
  readonly revisedByActorId: string;
}

/** A whole revision's body, each line tagged so a test can tell two apart. */
export const knowledge = (tag: string): Readonly<Record<string, unknown>> => ({
  step: `read the page ${tag}`,
  valid: [{ k: 'Live opening', v: `about the practice ${tag}` }],
  unknowns: [`whether the form loses the reader ${tag}`],
  stale: [{ k: 'Hours', why: `changed since the brief ${tag}` }],
});

export interface RevisionsWorld {
  readonly c: Controls;
  readonly writer: Member;
  readonly canary: string;
  /** A's run, already revised once with the canary in every line. */
  readonly workA: PickedUp;
  readonly taskB: string;
  readonly leaseB: string;
  readonly fenceB: number;
  revise(work: PickedUp, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  asAgentB(name: string, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  revisionsOn(taskId: string): Promise<readonly RevisionRead[]>;
}

/** Agent B, linked by the writer; answers its token. */
async function agentLinkedBy(c: Controls, writer: Member): Promise<string> {
  const { db, business } = c.fixture;
  const agent = randomUUID();
  const subject = `agent-${randomUUID()}`;
  await db.app.withBusiness(business, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      business,
      agent,
    ]);
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [business, randomUUID(), loginId, agent, writer.actorId],
    );
  });
  return await tokenFor(subject);
}

/** Task B, approved by the writer, picked up by the agent the token names. */
async function pickedUpByB(c: Controls, writer: Member, tokenB: string) {
  const task = await c.createTask('client two');
  const proposal = await c.propose(task.id, task.revision, 'run_client_two');
  const decided = await c.asPerson(
    'task.decide',
    {
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'approved by a person without run:write',
    },
    writer,
  );
  expect(decided.status).toBe(200);
  const picked = await post(
    c.api,
    agentPath('task.pickup'),
    { operationId: randomUUID(), reservationId: detailOf(decided)['reservationId'] },
    authorised(tokenB),
  );
  expect(picked.status).toBe(200);
  return { taskB: task.id, detail: detailOf(picked) };
}

export async function revisionsWorld(name: string): Promise<RevisionsWorld> {
  const world = await checksWorld(name);
  const { c, writer } = world;
  await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
    await grantTo(tx, c.manager, 'write', undefined, false, 'run');
    await grantTo(tx, writer, 'comment');
    await grantTo(tx, writer, 'decide');
  });
  const revise = async (work: PickedUp, body: Readonly<Record<string, unknown>>) =>
    await c.asAgent(
      'run.revise_state',
      { leaseId: work.leaseId, fence: work.fence, ...body },
      work.credential,
    );
  const canary = `CANARY-${randomUUID()}`;
  const workA = await pickedUpOn(c, 'run_client_one');
  expect((await revise(workA, knowledge(canary))).status).toBe(200);

  const tokenB = await agentLinkedBy(c, writer);
  const { taskB, detail } = await pickedUpByB(c, writer, tokenB);
  const bravo = await insertBusiness(c.fixture.db.app, 'bravo');
  await installSpine(c.fixture.db.app, bravo);

  return {
    c,
    writer,
    canary,
    workA,
    taskB,
    leaseB: String(detail['leaseId']),
    fenceB: Number(detail['fence']),
    revise,
    asAgentB: async (command, body) =>
      await post(
        c.api,
        agentPath(command),
        { operationId: randomUUID(), ...body },
        { ...authorised(tokenB), 'x-agent-delegation': String(detail['credential']) },
      ),
    revisionsOn: async (taskId) => {
      const read = await c.asPerson('task.read', { recordId: taskId });
      expect(read.status).toBe(200);
      const [proposal] = read.body['proposals'] as readonly {
        versions: readonly { revisions: readonly RevisionRead[] }[];
      }[];
      return (proposal?.versions ?? []).flatMap((version) => version.revisions);
    },
  };
}
