// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan may call the agent's two tools
// (#2115). Commit A's text-only proof, changed on purpose: a turn offering
// the tools hands back the plan's calls in shape, under the catalogue's
// names, settled, for the runner to run; the turn itself drafts nothing. A
// turn offering none that is answered with a call, or a call out of shape,
// is held as unknown once written: the calls reach no runner and no
// correction exists for the task. Through the carried deployment's real
// operation and adapter, the model agent and the plan's custody.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import { completed, stream } from '../custody/fixtures/plan-answer-world.ts';
import { toolCallReply, words, type Reply } from '../custody/fixtures/plan-route-world.ts';
import { rowsOf, s, useBrokerWorld } from '../broker/broker-world.ts';
import { openCarriedTaskWorld, type CarriedTaskWorld } from '../broker/carried-task-world.ts';
import { carriedTurn, turnBrokerOf } from '../broker/carried-turn-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('textonly');

const TOOLS = ['task.read', 'live_correction.request'];

const fresh = async (title: string): Promise<Work> =>
  await liveWork(s, `${title} ${randomUUID()}`, 2_000);

/** A correction the model asks for, as the plan names its tools. */
const correction = (work: Work) => ({
  taskId: work.taskId,
  page: '/',
  word: 'teh',
  replacement: 'the',
});

/** Words and, beside them, a call: the turn's answer with both. */
function wordsAndCall(work: Work): Reply {
  const call = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'live_correction_request',
    arguments: JSON.stringify(correction(work)),
    status: 'completed',
  };
  return {
    status: 200,
    type: 'text/event-stream',
    body: stream(completed(['Fixing the typo.'], [call]), ['Fixing the typo.']),
  };
}

async function correctionsOf(work: Work): Promise<number> {
  const [row] = await s.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from public.live_corrections where business_id = $1 and task_id = $2`,
    [s.business, work.taskId],
  );
  return row?.n ?? 0;
}

// oxlint-disable-next-line max-lines-per-function -- one world, kept and held answers and the control
describe.skipIf(serverUrl === undefined)('a plan turn that is sent calls', () => {
  let world: CarriedTaskWorld;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  /** The work's first turn offering `tools`, the plan answering `reply`; what was sent and kept. */
  async function answeredWith(work: Work, reply: Reply, tools: readonly string[]) {
    world.plan.reply = () => reply;
    const sent = world.plan.sent.length;
    try {
      const answer = await carriedTurn(world, work, turnBrokerOf(world), tools);
      const [row] = await rowsOf(answer.callId);
      const offered = JSON.parse(world.plan.sent.at(-1)?.raw ?? '{}').tools ?? [];
      return {
        answer,
        sent: world.plan.sent.length - sent,
        state: row?.['state'],
        offered: offered.map((tool: { name: string }) => tool.name),
      };
    } finally {
      world.plan.reply = () => words('Done.');
    }
  }

  const kept: readonly (readonly [string, (work: Work) => Reply, (work: Work) => unknown])[] = [
    [
      'a correction call alone',
      (work) => toolCallReply('live_correction_request', JSON.stringify(correction(work))),
      (work) => [{ id: 'call_1', name: 'live_correction.request', args: correction(work) }],
    ],
    [
      'a read call alone',
      (work) => toolCallReply('task_read', JSON.stringify({ taskId: work.taskId })),
      (work) => [{ id: 'call_1', name: 'task.read', args: { taskId: work.taskId } }],
    ],
    [
      'words beside a correction call',
      wordsAndCall,
      (work) => [{ id: 'call_1', name: 'live_correction.request', args: correction(work) }],
    ],
  ];

  for (const [name, reply, calls] of kept) {
    it(`offering the tools, hands back ${name} settled, and drafts no correction itself`, async () => {
      const work = await fresh(`Offered, ${name}`);
      const called = await answeredWith(work, reply(work), TOOLS);
      expect(called).toMatchObject({ sent: 1, state: 'settled' });
      expect(called.answer).toMatchObject({ ok: true, toolCalls: calls(work) });
      expect(called.offered).toStrictEqual(['task_read', 'live_correction_request']);
      expect(await correctionsOf(work)).toBe(0);
    }, 60_000);
  }

  const held: readonly (readonly [string, (work: Work) => Reply, readonly string[]])[] = [
    [
      'offering none, a correction call',
      (work) => toolCallReply('live_correction_request', JSON.stringify(correction(work))),
      [],
    ],
    [
      'offering only the read, a correction call',
      (work) => toolCallReply('live_correction_request', JSON.stringify(correction(work))),
      ['task.read'],
    ],
    [
      'a read under its dotted catalogue name',
      (work) => toolCallReply('task.read', JSON.stringify({ taskId: work.taskId })),
      TOOLS,
    ],
    [
      'a read with a key of its own',
      (work) => toolCallReply('task_read', JSON.stringify({ taskId: work.taskId, extra: 'x' })),
      TOOLS,
    ],
    [
      'a correction whose word is a number',
      (work) =>
        toolCallReply('live_correction_request', JSON.stringify({ ...correction(work), word: 9 })),
      TOOLS,
    ],
  ];

  for (const [name, reply, tools] of held) {
    it(`holds ${name} as unknown, and no correction exists for the task`, async () => {
      const work = await fresh(`Held, ${name}`);
      const called = await answeredWith(work, reply(work), tools);
      expect(called).toMatchObject({ sent: 1, state: 'liability_unknown' });
      expect(called.answer).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
      expect(called.answer).not.toHaveProperty('toolCalls');
      expect(await correctionsOf(work)).toBe(0);
    }, 60_000);
  }

  it('control: words alone settle as the answer, with no calls', async () => {
    const work = await fresh('Plan turn, words');
    const called = await answeredWith(work, words('Nothing to correct.'), TOOLS);
    expect(called).toMatchObject({ sent: 1, state: 'settled' });
    expect(called.answer).toMatchObject({ ok: true, text: 'Nothing to correct.' });
    expect(called.answer.ok && called.answer.toolCalls).toBeFalsy();
  }, 60_000);
});
