// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's hero tokens cell, its read half: `task.read`'s proposal versions
// carry the token units their run's model calls recorded (input and output,
// 0204), summed in this business and on this run, through the real boundary,
// the replay broker and a fresh Postgres. The agent makes real `model.call`s
// under its lease; the model_calls rows, read as admin, are the oracle. The
// crossings: another business, an external party of this business, and the
// agent under a live delegation on another task, each refused with no units
// or version id in any body.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  enrolExternal,
  personPath,
  serverUrl,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import { asAgent, asPerson, signed, type Signed } from './c54-fixture.ts';

const detailOf = (answer: Answer): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

interface Work {
  readonly taskId: string;
  readonly versionId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

// eslint-disable-next-line max-lines-per-function -- one world, the units and each crossing on it
describe.skipIf(serverUrl === undefined)('MP-6-2 run tokens', () => {
  let world: World;
  let ada: Signed;
  let work: Work;

  /** A task whose plan ada approved and the agent picked up. */
  const pickedUp = async (title: string): Promise<Work> => {
    const task = await asPerson(world, ada, 'task.create', { fields: { title } });
    const taskId = String(task.body['recordId']);
    const proposed = await asPerson(world, ada, 'task.propose', {
      recordId: taskId,
      expectedRevision: Number(task.body['revision']),
      ...PROPOSAL,
    });
    const decided = await asPerson(world, ada, 'task.decide', {
      gateId: detailOf(proposed)['gateId'],
      versionId: detailOf(proposed)['versionId'],
      decision: 'approve',
      note: 'approved for a run that spends tokens',
    });
    const picked = await call(
      world.api,
      agentPath('alpha', '/task/pickup'),
      { operationId: randomUUID(), reservationId: detailOf(decided)['reservationId'] },
      bearer(world.agent.token),
    );
    expect(picked.code).toBe('ok');
    const lease = detailOf(picked);
    return {
      taskId,
      versionId: String(detailOf(proposed)['versionId']),
      runId: String(lease['runId']),
      leaseId: String(lease['leaseId']),
      fence: Number(lease['fence']),
      credential: String(lease['credential']),
    };
  };

  const unitsRead = async (): Promise<unknown> => {
    const read = await asPerson(world, ada, 'task.read', { recordId: work.taskId });
    const proposals = (read.body['task'] as { proposals: unknown }).proposals as readonly {
      readonly versions: readonly { readonly versionId: string; readonly tokenUnits?: unknown }[];
    }[];
    return proposals.flatMap((p) => p.versions).find((v) => v.versionId === work.versionId)
      ?.tokenUnits;
  };
  const unitsStored = async (runId: string): Promise<number> =>
    Number(
      (
        await world.db.admin.execute<{ readonly n: string }>(
          `select coalesce(sum(input_units + output_units), 0)::text as n
             from public.model_calls where run_id = $1`,
          [runId],
        )
      )[0]?.n,
    );
  const modelCall = async (on: Work): Promise<Answer> =>
    await asAgent(
      world,
      'model.call',
      {
        leaseId: on.leaseId,
        fence: on.fence,
        operation: 'model.replay_compose',
        fields: [{ name: 'tone', from: { recordId: on.taskId, key: 'title' } }],
      },
      on.credential,
    );

  /** The run handed back, so the agent's one live delegation is free for the next. */
  const handBack = async (on: Work): Promise<void> => {
    const back = await asAgent(
      world,
      'task.handback',
      { leaseId: on.leaseId, fence: on.fence, outcome: 'completed', report: { wrote: 'done' } },
      on.credential,
    );
    expect(back.code).toBe('ok');
  };

  beforeAll(async () => {
    world = await createWorld('mp62tokens');
    ada = signed(world.ada);
    // Another task's run first: its calls are in this business, not this run.
    const sibling = await pickedUp('another task whose run spends tokens');
    expect((await modelCall(sibling)).code).toBe('ok');
    await handBack(sibling);
    work = await pickedUp('a run that spends tokens');
  }, 180_000);

  afterAll(async () => await world?.close());

  it('MP-6-2 run tokens: a run with no call reads none, and each settled call’s units add to its run’s', async () => {
    expect(await unitsRead()).toBeNull();
    expect((await modelCall(work)).code).toBe('ok');
    expect((await modelCall(work)).code).toBe('ok');
    const stored = await unitsStored(work.runId);
    expect(stored).toBeGreaterThan(0);
    expect(await unitsRead()).toBe(stored);
    await handBack(work);
  });

  it('MP-6-2 run tokens isolation: another business, an external party and the agent on another task read no units of this run', async () => {
    const units = String(await unitsStored(work.runId));
    const carriesNothing = (answer: Answer): void => {
      expect(answer.code).not.toBe('ok');
      const text = JSON.stringify(answer.body);
      expect(text).not.toContain(work.versionId);
      expect(text).not.toContain(`"tokenUnits":${units}`);
    };
    const bea = signed(world.bea);
    const across = await asPerson(world, bea, 'task.read', { recordId: work.taskId });
    const madeUp = await asPerson(world, bea, 'task.read', { recordId: randomUUID() });
    expect(across.status).toBe(404);
    expect(across.body).toEqual(madeUp.body);
    carriesNothing(across);
    const external = await enrolExternal(world);
    carriesNothing(
      await call(
        world.api,
        personPath('alpha', '/task/read'),
        { recordId: work.taskId },
        bearer(external.token),
      ),
    );
    const other = await pickedUp('the agent’s other task');
    carriesNothing(await asAgent(world, 'task.read', { recordId: work.taskId }, other.credential));
  });
});
