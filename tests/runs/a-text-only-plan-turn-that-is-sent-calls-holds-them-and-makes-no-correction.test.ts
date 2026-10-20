// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan is text only (#2091, commit A): it
// offers the plan no tool, so a plan answer that asks for any, with words or
// without, is malformed. Once written, the turn may have run, so the call is
// held as unknown, its calls reach no runner, and no correction is drafted
// for the task. Through the carried deployment's real operation and adapter,
// the model agent and the plan's custody.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import { completed, stream } from '../custody/fixtures/plan-answer-world.ts';
import { toolCallReply, words, type Reply } from '../custody/fixtures/plan-route-world.ts';
import { rowsOf, s, useBrokerWorld } from '../broker/broker-world.ts';
import { openCarriedTaskWorld, type CarriedTaskWorld } from '../broker/carried-task-world.ts';
import { carriedTurn } from '../broker/carried-turn-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('textonly');

const fresh = async (title: string): Promise<Work> =>
  await liveWork(s, `${title} ${randomUUID()}`, 2_000);

/** A correction the model asks for, as the plan names its tools. */
const correction = (work: Work): string =>
  JSON.stringify({ taskId: work.taskId, page: '/', word: 'teh', replacement: 'the' });

/** Words and, beside them, a call: the turn's answer with both. */
function wordsAndCall(work: Work): Reply {
  const call = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'live_correction_request',
    arguments: correction(work),
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

// oxlint-disable-next-line max-lines-per-function -- one world, three answers and the control
describe.skipIf(serverUrl === undefined)('a text-only plan turn that is sent calls', () => {
  let world: CarriedTaskWorld;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  /** The work's first turn, the plan answering `reply`; what was sent and kept. */
  async function answeredWith(work: Work, reply: Reply) {
    world.plan.reply = () => reply;
    const sent = world.plan.sent.length;
    try {
      const answer = await carriedTurn(world, work);
      const [row] = await rowsOf(answer.callId);
      return { answer, sent: world.plan.sent.length - sent, state: row?.['state'] };
    } finally {
      world.plan.reply = () => words('Done.');
    }
  }

  const cases: readonly (readonly [string, (work: Work) => Reply])[] = [
    [
      'a correction call alone',
      (work) => toolCallReply('live_correction_request', correction(work)),
    ],
    [
      'a read call alone',
      (work) => toolCallReply('task_read', JSON.stringify({ taskId: work.taskId })),
    ],
    ['words beside a correction call', wordsAndCall],
  ];

  for (const [name, reply] of cases) {
    it(`holds ${name} as unknown, and no correction exists for the task`, async () => {
      const work = await fresh(`Text only, ${name}`);
      const called = await answeredWith(work, reply(work));
      expect(called).toMatchObject({ sent: 1, state: 'liability_unknown' });
      expect(called.answer).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
      expect(called.answer).not.toHaveProperty('toolCalls');
      expect(await correctionsOf(work)).toBe(0);
    }, 60_000);
  }

  it('control: words alone settle as the answer, with no calls', async () => {
    const work = await fresh('Text only, words');
    const called = await answeredWith(work, words('Nothing to correct.'));
    expect(called).toMatchObject({ sent: 1, state: 'settled' });
    expect(called.answer).toMatchObject({ ok: true, text: 'Nothing to correct.' });
    expect(called.answer.ok && called.answer.toolCalls).toBeFalsy();
  }, 60_000);
});
