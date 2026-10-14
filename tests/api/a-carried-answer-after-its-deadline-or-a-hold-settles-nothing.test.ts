// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried call's answer settles only through its fence, under the call's
// lock: the call still dispatched, the runner its send recorded, and before
// the `answer_by` the send set. An answer the agent holds back until
// `answer_by` has passed, or until the call was held meanwhile, settles
// nothing: no amount, no reply kept, and the person is told the answer did
// not finish, never shown a success. Unheld, the same answer settles at
// nothing and is kept.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// Ollama's wait cut to one second, so `answer_by` (the send plus W, the wait and ten seconds) comes soon.
const TIMEOUT_MS = 1_000;

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a carried answer held back', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_late_answer', TIMEOUT_MS);
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Two.']) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  /** Until the carriers row's `answer_by` has passed on the database's clock. */
  async function pastAnswerBy(body: string): Promise<void> {
    for (let tries = 0; tries < 400; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- reads the database's clock until it passes
      const [row] = await world.w.fixture.db.admin.execute<{ readonly past: boolean }>(
        `select k.answer_by < clock_timestamp() as past
           from public.model_call_carriers k
           join public.model_calls c on c.business_id = k.business_id and c.id = k.call_id
           join public.conversation_messages m on m.id = c.conversation_message_id
          where m.body = $1`,
        [body],
      );
      if (row?.past === true) return;
      // oxlint-disable-next-line no-await-in-loop -- waits between reads
      await sleep(100);
    }
    throw new Error('answer_by never passed');
  }

  it.each(['answer_by passed', 'held meanwhile'] as const)(
    'an answer sent after %s settles nothing, keeps nothing and says it did not finish',
    async (moment) => {
      const body = `Two? (${moment})`;
      world.agent.mode = 'late-answer';
      const asking = ask(world, body);
      await world.agent.dispatched(1);
      if (moment === 'answer_by passed') await pastAnswerBy(body);
      else {
        await world.w.fixture.db.admin.execute(
          `update public.model_calls c
              set state = 'liability_unknown', fault = 'ours', drop_state = 'dropped_no_answer',
                  unknown_since = clock_timestamp()
             from public.conversation_messages m
            where m.id = c.conversation_message_id and m.body = $1 and c.state = 'dispatched'`,
          [body],
        );
      }
      world.agent.release();
      const events = await (await asking).rest();
      expect(await callFor(world, body)).toEqual([
        { state: 'liability_unknown', offered: true, requested: true, actual: null },
      ]);
      expect(await repliesTo(world, body)).toBe(0);
      const outcome = JSON.parse(events.at(-1)?.data ?? '{}') as Record<string, unknown>;
      expect(outcome).toMatchObject({ reply: { answered: false, code: 'DECISION_STALE' } });
    },
    60_000,
  );

  it('unheld, the same answer settles at nothing and is kept', async () => {
    const body = 'Two? (unheld)';
    const events = await (await ask(world, body)).rest();
    expect(await callFor(world, body)).toEqual([
      { state: 'settled', offered: true, requested: true, actual: 0 },
    ]);
    expect(await repliesTo(world, body)).toBe(1);
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: true } });
  }, 60_000);
});
