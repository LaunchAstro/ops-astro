// SPDX-License-Identifier: AGPL-3.0-only
//
// End to end on a carried deployment: the person asks in the side panel, the
// function offers the call, the model agent accepts, the function's send
// judgement passes, the agent's custody writes the chat to Ollama, and the
// words come back as pieces while Ollama is still writing. The reply is kept
// and settled at nothing, the call's carriers row has every time set, the
// conversation has one agent membership, and Ollama was asked once.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, repliesTo } from './carried-schedules.ts';
import { withModelAgent, type CarriedAgent } from './model-agent-carried.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today.'];

// oxlint-disable-next-line max-lines-per-function -- the world and its one journey
describe.skipIf(serverUrl === undefined)('the side panel through the model agent', () => {
  let world: CarriedWorld;
  let carried: CarriedAgent;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('model_agent_end_to_end');
    carried = await withModelAgent(world);
  }, 180_000);

  afterAll(async () => {
    await carried?.stop();
    await world?.close();
    vi.unstubAllEnvs();
  });

  it('streams the first piece while Ollama still writes, then keeps the settled reply', async () => {
    const body = 'What is due today?';
    world.ollama.reply = (model) => ({
      status: 200,
      chunks: streamedLines(model, WORDS),
      holdAfter: 2,
    });
    const streaming = await ask(world, body);
    await Promise.race([world.ollama.midway(), sleep(8_000)]);
    const first = await streaming.next();
    expect(first?.event).toBe('piece');
    expect(await repliesTo(world, body)).toBe(0);
    world.ollama.resume();
    const events = [first, ...(await streaming.rest())];
    const shown = events
      .filter((event) => event?.event === 'piece')
      .map((event) => event?.data ?? '')
      .join('');
    expect(shown).toBe(WORDS.join(''));
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: true } });
    expect(world.ollama.seen).toHaveLength(1);
    expect(world.agent.sent).toHaveLength(0);
    expect(await repliesTo(world, body)).toBe(1);
    expect(await callFor(world, body)).toEqual([
      { state: 'settled', offered: true, requested: true, actual: 0 },
    ]);
    const { admin } = world.w.fixture.db;
    const [times] = await admin.execute<{ readonly all: boolean; readonly members: string }>(
      `select bool_and(k.offered_at is not null and k.runner = $1::uuid and k.request_at is not null
                       and k.send_by is not null and k.answer_by is not null) as all,
              (select count(*)::text from public.conversation_agent_members m
                where m.business_id = c.business_id and m.conversation_id = c.conversation_id) as members
         from public.model_calls c
         join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
        group by c.business_id, c.conversation_id`,
      [carried.agent.runner],
    );
    expect(times).toEqual({ all: true, members: '1' });
  }, 60_000);
});
