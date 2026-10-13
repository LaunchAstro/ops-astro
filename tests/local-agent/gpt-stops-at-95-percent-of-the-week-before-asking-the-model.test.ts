// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT on the owner's plan shares its ChatGPT account with the reviewer, so the
// chat stops at 95% of the account's week. Before any thread is started, a
// streamed call reads the plan's own usage report. At 95% or more of the
// weekly window (whichever of the two windows it is), or with the plan's
// ordinary-usage permission not affirmatively given, or with no weekly window
// at all, the model is asked nothing. The 5-hour window is left to Codex's own limit.

import { describe, expect, it } from 'vitest';
import { answerOf, runnerWorld } from './runner-world.ts';

const { start, call } = runnerWorld();
const message = { fields: { message: 'What is on the board today?' }, stream: true };

/** A streamed call on a plan reading as `knobs` says: its answer, what the model was asked, the last ledger row. */
async function ask(knobs: Record<string, unknown>) {
  const { w, r } = await start();
  w.knobs(knobs);
  const reply = await call(r, message);
  const threads = w
    .appCalls()
    .filter(
      (entry) => (entry['message'] as { method?: string } | undefined)?.method === 'thread/start',
    );
  return { answer: answerOf(reply.raw), asked: w.asked(), threads, last: w.ledger().at(-1) };
}

describe('the week at 95%', () => {
  it.each([
    ['as the secondary window', { weekly: 95 }],
    ['as the primary window', { weekly: 97, swap: true }],
  ])('asks the model nothing, %s, and charges nothing', async (_label, knobs) => {
    const { answer, asked, threads, last } = await ask(knobs);
    expect(answer).toMatchObject({ text: '', code: 'GPT_WEEK_RESERVED' });
    expect(asked).toEqual([]);
    expect(threads).toEqual([]);
    expect(last).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('asks the model at 94%, with the permission given', async () => {
    const { answer, asked } = await ask({ weekly: 94, permission: true });
    expect(answer).toMatchObject({ text: 'Two tasks are due.', code: null });
    expect(asked).toEqual(['What is on the board today?']);
  });

  it('leaves the 5-hour window to Codex: at 99% it still asks', async () => {
    const { answer, asked } = await ask({ fiveHour: 99 });
    expect(answer).toMatchObject({ code: null });
    expect(asked).toHaveLength(1);
  });
});

describe('a reading that does not give permission', () => {
  it.each([
    ['null', { permission: null }, 'GPT_USAGE_UNKNOWN'],
    ['absent', { permission: 'absent' }, 'GPT_USAGE_UNKNOWN'],
    ['without a weekly window', { noWeekly: true }, 'GPT_USAGE_UNKNOWN'],
    ['false', { permission: false }, 'LOCAL_PLAN_LIMIT'],
    ['with a limit reached', { reached: 'rate_limit_reached' }, 'LOCAL_PLAN_LIMIT'],
  ])('asks the model nothing when the permission is %s', async (_label, knobs, code) => {
    const { answer, asked, threads } = await ask(knobs);
    expect(answer).toMatchObject({ text: '', code });
    expect(asked).toEqual([]);
    expect(threads).toEqual([]);
  });
});
