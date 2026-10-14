// SPDX-License-Identifier: AGPL-3.0-only
//
// A hosted function lost partway through a carried call, and the sweep that
// ends the call by what the carried custody recorded. Lost before its offer
// (stopped as it joins the call's line): a call never offered is no carried
// one's to release, since a process custody sends without an offer, so it is
// held by the ten-minute rule and never released at 60 seconds. Lost after it
// (stopped as it sends the request): `request_at` is set, so the request may
// have gone and the call is held once `answer_by` plus 60 seconds has passed,
// never sooner and never while the send's own judgement still holds it. A
// function that resumes after the sweep sends nothing and settles nothing,
// and the person's next message is answered.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, repliesTo, type CallRows } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';
import type { Streaming } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A wait the case ends: `stop` is the step that waits, once; `go` lets it on. */
function stopOnce(): { stop: () => Promise<void>; go: () => void; stopped: Promise<void> } {
  const reached = latch();
  const gone = latch();
  let used = false;
  return {
    stop: async () => {
      if (used) return;
      used = true;
      reached.open();
      await gone.promise;
    },
    go: () => gone.open(),
    stopped: reached.promise,
  };
}

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a carried function lost mid-answer', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_function_lost');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Done.']) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  const sweep = async () =>
    await world.database.withBusiness(
      world.w.fixture.business,
      async (tx) => await sweepModelCalls(tx),
    );

  /** The call asked with `body` moved back in time: its start. */
  const age = async (body: string, seconds: number): Promise<void> => {
    await world.w.fixture.db.admin.execute(
      `with asked as (
         select c.business_id, c.id from public.model_calls c
           join public.conversation_messages m
             on m.business_id = c.business_id and m.id = c.conversation_message_id
          where m.body = $1)
       update public.model_calls c
          set accepted_at = c.accepted_at - make_interval(secs => $2),
              started_at = c.started_at - make_interval(secs => $2)
         from asked where c.business_id = asked.business_id and c.id = asked.id`,
      [body, seconds],
    );
  };

  /**
   * The sent call's `answer_by`, `seconds` ago: the clock moved, not the row's
   * story: every time on it moves back together. The carriers row's set-once guard is a trigger, held off for this
   * one statement only.
   */
  const answerByAgo = async (seconds: number): Promise<void> => {
    await world.w.fixture.db.admin.transaction(async (execute) => {
      await execute(`set local session_replication_role = replica`);
      await execute(
        `update public.model_call_carriers
            set offered_at = offered_at - (answer_by - clock_timestamp() + make_interval(secs => $1)),
                request_at = request_at - (answer_by - clock_timestamp() + make_interval(secs => $1)),
                send_by = send_by - (answer_by - clock_timestamp() + make_interval(secs => $1)),
                answer_by = clock_timestamp() - make_interval(secs => $1)
          where request_at is not null`,
        [seconds],
      );
    });
  };

  /** After the function resumes: nothing sent, nothing kept, then a new message is answered. */
  async function afterResume(
    asking: Promise<Streaming>,
    body: string,
    ended: readonly CallRows[] | readonly unknown[],
  ): Promise<void> {
    const events = await (await asking).rest();
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
    expect(world.ollama.seen).toHaveLength(0);
    expect(await repliesTo(world, body)).toBe(0);
    expect(await callFor(world, body)).toEqual(ended);
    const next = await (await ask(world, `${body} again`)).rest();
    expect(JSON.parse(next.at(-1)?.data ?? '{}')).toMatchObject({
      reply: { answered: true, body: 'Done.' },
    });
    expect(world.ollama.seen).toHaveLength(1);
  }

  it('lost before its offer: held after ten minutes, never released at 60 seconds', async () => {
    const lost = stopOnce();
    world.beforeJoin.run = lost.stop;
    const body = 'What is due? (lost before the offer)';
    const asking = ask(world, body);
    await lost.stopped;
    await age(body, 61);
    expect(await sweep()).toEqual({ held: 0, released: 0 });
    await age(body, 538);
    expect(await sweep()).toEqual({ held: 0, released: 0 });
    await age(body, 2);
    expect(await sweep()).toEqual({ held: 1, released: 0 });
    const held = [{ state: 'liability_unknown', offered: false, requested: false, actual: null }];
    expect(await callFor(world, body)).toEqual(held);
    lost.go();
    // The resumed function's offer finds the call held: nothing offered, nothing sent. Its
    // refusal is proof nothing went, so the call may be released from its hold, never settled.
    await afterResume(asking, body, [
      expect.objectContaining({
        state: expect.stringMatching(/^(liability_unknown|released)$/u),
        offered: false,
        requested: false,
      }),
    ]);
    expect(world.agent.accepted).toHaveLength(1);
  }, 120_000);

  it('lost after its send was recorded: held after answer_by plus 60 seconds, never released', async () => {
    const lost = stopOnce();
    world.beforeSend.run = async (event) => {
      if (event === 'request') await lost.stop();
    };
    const body = 'What is due? (lost after the send)';
    const asking = ask(world, body);
    await lost.stopped;
    const sent = [{ state: 'dispatched', offered: true, requested: true, actual: null }];
    expect(await callFor(world, body)).toEqual(sent);
    // Before `answer_by` plus 60 seconds: not held, and never released.
    await age(body, 600);
    await answerByAgo(59);
    expect(await sweep()).toEqual({ held: 0, released: 0 });
    await answerByAgo(61);
    // The send's judgement lets its locks go within the send window; the sweep skips it till then.
    let swept = await sweep();
    for (let tries = 0; tries < 100 && swept.held === 0; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- waits out the send window's hold
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      // oxlint-disable-next-line no-await-in-loop -- one sweep after another
      swept = await sweep();
    }
    expect(swept).toEqual({ held: 1, released: 0 });
    const held = [{ state: 'liability_unknown', offered: true, requested: true, actual: null }];
    expect(await callFor(world, body)).toEqual(held);
    lost.go();
    // The resumed request is past its deadline: the agent refuses it and Ollama hears nothing.
    // The call stays held, or is released on the agent's sealed word that nothing was written.
    await afterResume(asking, body, [
      expect.objectContaining({
        state: expect.stringMatching(/^(liability_unknown|released)$/u),
        requested: true,
        actual: null,
      }),
    ]);
  }, 120_000);
});
