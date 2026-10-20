// SPDX-License-Identifier: AGPL-3.0-only
//
// A model's tool call out of shape runs no tool (#2091, gaps 4 and v2-1).
// The shipped agent runner computes an accepted plan; the replay model asks
// for a call the broker judges before the runner sees it: a correction whose
// page, word or replacement is not a string, an empty task id, a word past
// 4,096 units, a read with a key of its own, a tool the catalogue does not
// offer, a good call beside a bad sibling, or an id an earlier answer used.
// The whole answer is held as malformed: the runner is handed no call, no
// tool command reaches the product (no task read after the model call, no
// correction), and the attempt ends on the held call. The same holds on the
// owner's plan (#2115): the shipped runner on `model.agent_turn`, the carried
// deployment's broker, and the plan's stand-in asking for a read with a key
// of its own, a tool outside the table, a good call beside a bad sibling, or
// a call id its earlier answer used.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { AGENT_TURN_KEY, REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import { completed, stream } from '../custody/fixtures/plan-answer-world.ts';
import { toolCallReply, words, type Reply } from '../custody/fixtures/plan-route-world.ts';
import { openCarriedTaskWorld, type CarriedTaskWorld } from '../broker/carried-task-world.ts';
import { acceptedPlan, unproposed, verbsOf } from './compute-seam-world.ts';
import { ownersPlan, plansBroker, settingsOf } from './owners-plan-world.ts';
import { outcomesOf, s, useStopWorld, world } from './run-stop-world.ts';
import {
  agentBroker,
  correctionsOn,
  OWN_PAGE,
  ownSiteOf,
  replied,
  requestOf,
} from './agent-draft-world.ts';

useStopWorld('planturnnotool');

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await ownSiteOf(s, OWN_PAGE);
}, 180_000);

type Calls = (taskId: string) => readonly unknown[];

const ask = (id: string, args: Readonly<Record<string, unknown>>) => ({
  id,
  name: 'live_correction.request',
  args,
});
const read = (id: string, args: Readonly<Record<string, unknown>>) => ({
  id,
  name: 'task.read',
  args,
});

const CASES: readonly { readonly name: string; readonly calls: Calls }[] = [
  {
    name: 'a page that is an object',
    calls: (t) => [ask('c1', { ...requestOf(t), page: { injected: true } })],
  },
  { name: 'a word that is a number', calls: (t) => [ask('c1', { ...requestOf(t), word: 123 })] },
  {
    name: 'a replacement that is false',
    calls: (t) => [ask('c1', { ...requestOf(t), replacement: false })],
  },
  { name: 'an empty task id', calls: (t) => [ask('c1', { ...requestOf(t), taskId: '' })] },
  {
    name: 'a word past 4,096 units',
    calls: (t) => [ask('c1', { ...requestOf(t), word: 'a'.repeat(4097) })],
  },
  { name: 'a read with a key of its own', calls: (t) => [read('c1', { taskId: t, extra: 1 })] },
  { name: 'a read of a path', calls: () => [read('c1', { path: '/etc' })] },
  {
    name: 'a tool the catalogue does not offer',
    calls: (t) => [{ id: 'c1', name: 'run.end', args: { taskId: t } }],
  },
  {
    name: 'a good call beside a bad sibling',
    calls: (t) => [read('c1', { taskId: t }), ask('c2', { ...requestOf(t), word: 123 })],
  },
];

/** The verbs the worker sent after its first model call: none of them a tool's. */
const afterFirstCall = (verbs: readonly string[]): readonly string[] =>
  verbs.slice(verbs.indexOf('model.call') + 1);

describe.skipIf(serverUrl === undefined)('a model call out of shape', () => {
  it.each(CASES)(
    '$name: the answer is held and no tool runs',
    async ({ calls }) => {
      const seam = await acceptedPlan(
        'the about page spells the town wrong',
        agentRunner({ operation: REPLAY_TURN.key }),
        agentBroker(),
      );
      world.provider.script([replied('Doing it.', calls(seam.taskId))]);
      const outcome = await seam.worker.applyOnce(seam.taskId);
      expect(outcome).not.toHaveProperty('handedBack');
      const later = afterFirstCall(verbsOf(seam));
      expect(later).not.toContain('task.read');
      expect(later).not.toContain('live_correction.request');
      expect(await correctionsOn(seam.taskId), 'no correction').toHaveLength(0);
      expect(await outcomesOf(seam.work())).toMatchObject([{ end_code: 'LIABILITY_UNKNOWN' }]);
    },
    120_000,
  );

  it('an id an earlier answer used: the second answer is held and its tool never runs', async () => {
    const seam = await acceptedPlan(
      'the about page spells the town wrong',
      agentRunner({ operation: REPLAY_TURN.key }),
      agentBroker(),
    );
    const first = read('c1', { taskId: seam.taskId });
    world.provider.script([replied('Reading.', [first]), replied('Again.', [first])]);
    await seam.worker.applyOnce(seam.taskId);
    const verbs = verbsOf(seam);
    const firstCall = verbs.indexOf('model.call');
    const secondCall = verbs.lastIndexOf('model.call');
    expect(secondCall, 'two model calls').toBeGreaterThan(firstCall);
    expect(verbs.slice(firstCall + 1, secondCall), 'the first call ran once').toStrictEqual([
      'task.read',
    ]);
    expect(verbs.slice(secondCall + 1)).not.toContain('task.read');
    expect(await outcomesOf(seam.work())).toMatchObject([{ end_code: 'LIABILITY_UNKNOWN' }]);
  }, 120_000);
});

/** One of the plan's calls, as its completed response lists it. */
const planCall = (callId: string, name: string, args: unknown) => ({
  type: 'function_call',
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
  status: 'completed',
});

/** The plan's answer asking for a good read and then `sibling`, beside no words. */
function goodThenBad(taskId: string, sibling: Readonly<Record<string, unknown>>): Reply {
  const calls = [
    planCall('call_read', 'task_read', { taskId }),
    planCall('call_ask', 'live_correction_request', sibling),
  ];
  return { status: 200, type: 'text/event-stream', body: stream(completed([], calls), []) };
}

const PLAN_CASES: readonly { readonly name: string; readonly replies: (t: string) => Reply[] }[] = [
  {
    name: 'a read with a key of its own',
    replies: (t) => [toolCallReply('task_read', JSON.stringify({ taskId: t, extra: 'x' }))],
  },
  {
    name: 'a tool outside the table',
    replies: (t) => [toolCallReply('run_end', JSON.stringify({ taskId: t }))],
  },
  {
    name: 'a correction whose word is a number',
    replies: (t) => [
      toolCallReply('live_correction_request', JSON.stringify({ ...requestOf(t), word: 123 })),
    ],
  },
  {
    name: 'a good read beside a bad sibling',
    replies: (t) => [goodThenBad(t, { ...requestOf(t), replacement: false })],
  },
];

// oxlint-disable-next-line max-lines-per-function -- one carried world, its runner and both kinds of case
describe.skipIf(serverUrl === undefined)("a plan call out of shape, on the owner's plan", () => {
  let carried: CarriedTaskWorld;

  beforeAll(async () => {
    carried = await openCarriedTaskWorld(s);
  }, 180_000);

  afterAll(async () => {
    await carried?.close();
  });

  /** The owner's plan on a fresh task, worked once by the shipped runner, the plan answering `replies` in turn. */
  async function workedOnPlan(title: string, replies: (taskId: string) => Reply[]) {
    const broker = plansBroker(carried, settingsOf(carried.carrierAgent));
    const runner = agentRunner({ operation: AGENT_TURN_KEY });
    const { taskId, log, options } = await unproposed(title, runner, broker);
    await ownersPlan(taskId);
    const queue = replies(taskId);
    carried.plan.reply = () => queue.shift() ?? words('Asked once too often.');
    try {
      await createWorker(options).applyOnce(taskId);
    } finally {
      carried.plan.reply = () => words('Done.');
    }
    const verbs = log.map((sent) => sent.verb);
    const picked = log.find((sent) => sent.verb === 'task.pickup' && sent.status === 200);
    if (picked === undefined) throw new Error('the worker picked nothing up');
    const work = { taskId, proposal: {}, decision: {}, picked: picked.detail };
    return { taskId, verbs, outcomes: await outcomesOf(work) };
  }

  it.each(PLAN_CASES)(
    '$name: the answer is held and no tool runs',
    async ({ name, replies }) => {
      const worked = await workedOnPlan(`On the plan, ${name}`, replies);
      const later = afterFirstCall(worked.verbs);
      expect(later).not.toContain('task.read');
      expect(later).not.toContain('live_correction.request');
      expect(await correctionsOn(worked.taskId), 'no correction').toHaveLength(0);
      expect(worked.outcomes).toMatchObject([{ end_code: 'LIABILITY_UNKNOWN' }]);
    },
    120_000,
  );

  it('an id its earlier answer used: the second answer is held and its tool never runs', async () => {
    const worked = await workedOnPlan('On the plan, a reused id', (t) => [
      toolCallReply('task_read', JSON.stringify({ taskId: t }), 'call_read'),
      toolCallReply('task_read', JSON.stringify({ taskId: t }), 'call_read'),
    ]);
    const firstCall = worked.verbs.indexOf('model.call');
    const secondCall = worked.verbs.lastIndexOf('model.call');
    expect(secondCall, 'two model calls').toBeGreaterThan(firstCall);
    expect(worked.verbs.slice(firstCall + 1, secondCall), 'the first call ran once').toStrictEqual([
      'task.read',
    ]);
    expect(worked.verbs.slice(secondCall + 1)).not.toContain('task.read');
    expect(worked.outcomes).toMatchObject([{ end_code: 'LIABILITY_UNKNOWN' }]);
  }, 120_000);
});
