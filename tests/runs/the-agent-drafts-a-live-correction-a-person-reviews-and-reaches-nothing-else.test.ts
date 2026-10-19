// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R7 (#1716), on the database: the agent drafts the live correction.
// The worker's plan on the owner's own task is accepted and not launched, and
// at its compute the shipped agent runner reads the task, asks
// `live_correction.request` with a person's operands, `{taskId, page, word,
// replacement}`, and answers. Every call goes through the real HTTP agent
// door under the pickup's delegation, and every turn through the real broker
// to the replay provider. The request is stored `locating` with nothing
// pinned, as a person's is, requested by the agent for the delegating person
// under the run's own delegation; the run is handed back for review, and
// nothing is launched, decided or sent to the site. The owner reads the draft.
//
// The agent gets nothing a person would not: a request for another task, or
// for the own site from a client's task, is refused at the door and stores
// nothing, and a client's task gets no turn at all. A turn that carries back
// a correction of another lease's delegation, of another task or of another
// business is refused `PROVENANCE_UNBOUND` in the same bytes, naming nothing
// foreign; a turn that carries back an answer asking a correction with an
// operand a person cannot send is refused `TURN_MALFORMED`. Each is refused
// before any send.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import { REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { statusOf } from '../../packages/core-records/src/index.ts';
import { clientHere } from '../reads/client-rows.ts';
import {
  appliedDetail,
  asPerson,
  createTask,
  revisionOf,
  seedSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { acceptedPlan, decisionsOn, verbsOf, type Seam } from './compute-seam-world.ts';
import {
  named,
  outcomesOf,
  s,
  shapeOf,
  useStopWorld,
  world,
  type Answer,
} from './run-stop-world.ts';
import {
  agentBroker,
  anEarlierLeasesCorrection,
  answerPart,
  askedTurn,
  correctionsOn,
  delegationOfLease,
  namingCorrection,
  OWN_PAGE,
  ownSiteOf,
  receiptsOf,
  replied,
  requestAsAgent,
  requestOf,
  taskPart,
  THEIR_PAGE,
  turn,
  UUID,
  WORDS,
  workOn,
  type Earlier,
} from './agent-draft-world.ts';

useStopWorld('r7agentdraft');

let other: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await ownSiteOf(s, OWN_PAGE);
  other = await seedSchedules(s.db, 'r7agentdraft-other', 1_000_000);
  await ownSiteOf(other, THEIR_PAGE);
}, 180_000);

/** The worker's plan computed by the shipped agent runner, its three turns scripted. */
async function drafted(): Promise<{ readonly seam: Seam; readonly sent: number }> {
  const seam = await acceptedPlan(
    'the about page spells the town wrong',
    agentRunner({ operation: REPLAY_TURN.key }),
    agentBroker(),
  );
  const read = { id: 'call_1', name: 'task.read', args: { taskId: seam.taskId } };
  const ask = { id: 'call_2', name: 'live_correction.request', args: requestOf(seam.taskId) };
  world.provider.script([
    replied('Reading the task.', [read]),
    replied('Asking.', [ask]),
    replied('Drafted for your decision.'),
  ]);
  const seen = world.provider.seen.length;
  const outcome = await seam.worker.applyOnce(seam.taskId);
  expect(outcome, JSON.stringify(outcome)).toHaveProperty('handedBack');
  return { seam, sent: world.provider.seen.length - seen };
}

/** Claim 1: one row, stored as a person's is, on the own site with nothing pinned. Its id. */
async function expectStoredAsAPersonsRequest(seam: Seam): Promise<string> {
  const stored = await correctionsOn(seam.taskId);
  expect(stored, 'one correction on the task').toHaveLength(1);
  expect(stored[0]).toEqual({
    id: expect.stringMatching(UUID),
    state: 'locating',
    party_id: null,
    base_revision: null,
    version_id: null,
    pre_image_digest: null,
    requested_by_actor_id: s.agentActorId,
    requested_by_person_id: s.decider.personId,
    delegation_id: await delegationOfLease(seam.work().picked['leaseId']),
    page_url: OWN_PAGE,
    ...WORDS,
  });
  return String(stored[0]?.id);
}

/** Claim 2: a success handed back once for review; nothing launched, decided or sent to the site. */
async function expectReviewedNotLaunched(seam: Seam, correctionId: string): Promise<void> {
  const verbs = verbsOf(seam);
  expect(verbs.filter((verb) => verb === 'task.handback')).toHaveLength(1);
  expect(shapeOf(await outcomesOf(seam.work()))).toEqual([named('success', 'COMPLETED')]);
  for (const verb of ['task.comment', 'task.observe', 'live_correction.decide']) {
    expect(verbs, `no ${verb}`).not.toContain(verb);
  }
  const dispatched = seam.log.filter((sent) => sent.verb === 'task.dispatch');
  expect(dispatched.map((sent) => sent.status)).not.toContain(200);
  expect(await decisionsOn(seam.taskId), 'only the plan was accepted').toBe(1);
  expect(await receiptsOf(correctionId), 'no site work').toBe(0);
  const requests = seam.log.filter((sent) => sent.verb === 'live_correction.request');
  expect(requests.map((sent) => [sent.status, sent.detail])).toEqual([
    [200, { correctionId, state: 'locating' }],
  ]);
}

describe.skipIf(serverUrl === undefined)('the agent drafts a live correction', () => {
  it('stores one locating request as a person makes it, hands back for review, and the owner reads it', async () => {
    const { seam, sent } = await drafted();
    const correctionId = await expectStoredAsAPersonsRequest(seam);
    await expectReviewedNotLaunched(seam, correctionId);

    // Claim 3: three sends, the third carrying the request's result as the row by id.
    expect(sent, 'three turns sent').toBe(3);
    const turns = seam.log.filter((each) => each.verb === 'model.call');
    expect(turns.map((each) => each.status)).toEqual([200, 200, 200]);
    const parts = turns[2]?.body['parts'] as readonly unknown[] | undefined;
    expect(parts?.at(-1)).toEqual({ ref: 'correction', correctionId, toolCallId: 'call_2' });

    // Claim 4: the owner reads the draft.
    const read = await executeRead(s.db.app, s.business, s.decider.presented, {
      read: 'live_correction.read',
      correctionId,
    });
    expect(read).toMatchObject({ ok: true, correction: { correctionId, state: 'locating' } });
  }, 120_000);
});

/** A refusal's code and the status the register gives it. */
const expectRefused = (answer: Answer, code: string, names?: readonly string[]): void => {
  expect(answer.body, JSON.stringify(answer.body)).toMatchObject({
    code,
    ...(names === undefined ? {} : { names }),
  });
  expect(answer.status).toBe(statusOf(code as never));
};

/** The owner's task put under a client of the business, then proposed and picked up. */
async function aClientsWork(): Promise<Work> {
  const taskId = await createTask(s, 'a client task');
  const client = await clientHere(s.db.admin, s.business, randomUUID());
  const body = {
    command: 'task.set_party',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(s, taskId),
    fields: { client },
  };
  appliedDetail(await asPerson(s, body), 'task.set_party');
  return await workOn(taskId);
}

describe.skipIf(serverUrl === undefined)('the agent asks only as a person would', () => {
  it("refuses a request for another task, out of the delegation's purpose, and stores nothing", async () => {
    const work = await workOn(await createTask(s, 'its own task'));
    const elsewhere = await createTask(s, 'another task of the owner');
    expectRefused(await requestAsAgent(work, requestOf(elsewhere)), 'DELEGATION_OUT_OF_PURPOSE', [
      'taskId',
    ]);
    expect(await correctionsOn(elsewhere)).toEqual([]);
    expect(await correctionsOn(work.taskId)).toEqual([]);
  }, 60_000);

  it("refuses the own site from a client's task at the door, and gives that task no turn", async () => {
    const work = await aClientsWork();
    expectRefused(await requestAsAgent(work, requestOf(work.taskId)), 'NOT_FOUND', ['page']);
    world.provider.script([replied('Asking.')]);
    const { answer, sent } = await turn(work, 0, [await taskPart(work)]);
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('CLIENT_MODEL_USE_OFF');
    expect(sent, 'nothing was sent').toBe(0);
    expect(await correctionsOn(work.taskId)).toEqual([]);
  }, 60_000);

  it('refuses a turn carrying back an ask with an operand a person cannot send', async () => {
    const work = await workOn(await createTask(s, 'a wider ask'));
    const first = await askedTurn(work, {
      ...requestOf(work.taskId),
      baseRevision: 'b'.repeat(40),
    });
    world.provider.script([replied('Done.')]);
    const { answer, sent } = await turn(work, 1, [await taskPart(work), answerPart(first)]);
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('TURN_MALFORMED');
    expect(sent, 'nothing was sent').toBe(0);
  }, 60_000);
});

/** A correction a person of the other business asked on their own site. */
async function anotherBusinessesCorrection(): Promise<string> {
  const taskId = await createTask(other, 'their own task');
  const body = { command: 'live_correction.request', operationId: randomUUID() };
  const asked = await asPerson(other, { ...body, ...requestOf(taskId, THEIR_PAGE) });
  return String(appliedDetail(asked, 'their request')['correctionId']);
}

/** The correction an earlier lease asked, made once before the cases that name it. */
let earlier: Earlier;

/** Each a correction no turn of the work may carry back. */
const CASES: readonly {
  readonly name: string;
  readonly make: () => Promise<{ readonly work: Work; readonly correctionId: string }>;
}[] = [
  {
    name: "another lease's delegation, on the same task",
    make: async () => ({
      work: await workOn(earlier.taskId, earlier.lineageId),
      correctionId: earlier.id,
    }),
  },
  {
    name: 'another task of this business',
    make: async () => ({
      work: await workOn(await createTask(s, 'not that task')),
      correctionId: earlier.id,
    }),
  },
  {
    name: 'another business',
    make: async () => ({
      correctionId: await anotherBusinessesCorrection(),
      work: await workOn(await createTask(s, 'ours, naming theirs')),
    }),
  },
];

describe.skipIf(serverUrl === undefined)('a correction result that is not the run’s own', () => {
  const refusals: Answer[] = [];

  beforeAll(async () => {
    earlier = await anEarlierLeasesCorrection();
  }, 120_000);

  it.each(CASES)(
    '$name is refused PROVENANCE_UNBOUND before any send',
    async ({ make }) => {
      const { work, correctionId } = await make();
      expect(correctionId).toMatch(UUID);
      const { answer, sent } = await namingCorrection(work, correctionId);
      expectRefused(answer, 'PROVENANCE_UNBOUND');
      expect(sent, 'nothing was sent').toBe(0);
      refusals.push(answer);
    },
    60_000,
  );

  it('every one is the same bytes, and names no id or state', () => {
    expect(refusals).toHaveLength(CASES.length);
    const [first] = refusals;
    for (const refusal of refusals) expect(refusal).toEqual(first);
    const text = JSON.stringify(first);
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(/locating|requested/u);
  });
});
