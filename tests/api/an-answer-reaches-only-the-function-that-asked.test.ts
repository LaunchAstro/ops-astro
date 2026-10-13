// SPDX-License-Identifier: AGPL-3.0-only
//
// Two people's carried answers written at the same moment (the business's
// one-at-a-time limit raised to two, so both are in flight): each function
// serving a person joins only its own call's line, so each stream carries
// only its own words and its own outcome. A person's token joins no other
// call's line, in their business or another, and the business's agent joins
// no other business's doorbell or line: the line's policy resolves a login in
// the topic's business only, and admits a call's owner and its offered agent.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Carriage } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hubCarriage } from '../support/hub-carriage.ts';
import { carriageBusiness, type CarriageBusiness } from './carriage-fixture.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { callFor } from './carried-schedules.ts';
import { tokenFor } from './fixture.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';
import { sendStreaming, type StreamEvent } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = [
  ['Ada ', 'has ', 'two ', 'tasks ', 'due.'],
  ['Ben ', 'has ', 'none ', 'today.'],
] as const;

const textOf = (events: readonly StreamEvent[]): string =>
  events
    .filter((event) => event.event === 'piece')
    .map((event) => event.data)
    .join('');

const replyOf = (events: readonly StreamEvent[]): Record<string, unknown> =>
  (JSON.parse(events.at(-1)?.data ?? '{}') as { reply?: Record<string, unknown> }).reply ?? {};

// oxlint-disable-next-line max-lines-per-function -- one world, a second business beside it
describe.skipIf(serverUrl === undefined)('an answer reaches only the function that asked', () => {
  let world: CarriedWorld;
  let beta: CarriageBusiness;
  let lines: Carriage;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    // Ollama answers one of a business's questions at a time; two here, so both are in flight at once.
    world = await carriedWorld('carriage_two_at_once', undefined, { concurrency: 2 });
    // The carrier's list is the world's own, read at each call: the colleague is carried too.
    (world.carrier.people as string[]).push(world.w.colleague.personId);
    beta = await carriageBusiness(world.w.fixture.db.app, 'beta');
    lines = hubCarriage(world.hub);
    let n = 0;
    world.ollama.reply = (model) => {
      const words = WORDS[n % 2] ?? WORDS[0];
      n += 1;
      // Each answer holds after its first word, so both are written to and in flight at once.
      return { status: 200, chunks: streamedLines(model, words), holdAfter: 1 };
    };
  }, 180_000);

  afterAll(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  /** Whether `token` may join `topic`; a joined line is left at once. */
  const joins = async (topic: string, token: string): Promise<boolean> => {
    const joined = await lines.join(topic, token);
    if (joined.ok) await joined.line.leave();
    return joined.ok;
  };

  /** The line of the call asked with `body`. */
  const lineOf = async (body: string): Promise<string> => {
    const [call] = await world.w.fixture.db.admin.execute<{ readonly id: string }>(
      `select c.id from public.model_calls c
         join public.conversation_messages m
           on m.business_id = c.business_id and m.id = c.conversation_message_id
        where m.body = $1`,
      [body],
    );
    return `carry:${world.w.fixture.business}:call:${call?.id ?? ''}`;
  };

  it('two people at once: each stream carries only its own words and outcome', async () => {
    const { w } = world;
    const asking = [
      sendStreaming(world.api, w.owner, 'conversation.start', { body: 'Due for Ada?' }),
      sendStreaming(world.api, w.colleague, 'conversation.start', { body: 'Due for Ben?' }),
    ];
    // Both requests are at Ollama, and both lines open, before either answer is finished.
    await world.ollama.arrived(2);
    const ownerLine = await lineOf('Due for Ada?');
    const colleagueLine = await lineOf('Due for Ben?');
    expect(world.joined.toSorted()).toEqual([ownerLine, colleagueLine].toSorted());
    const owner = await tokenFor(w.owner.presented.subject);
    const colleague = await tokenFor(w.colleague.presented.subject);
    expect(await joins(colleagueLine, owner)).toBe(false);
    expect(await joins(ownerLine, colleague)).toBe(false);
    // Controls: each person is admitted to their own call's line.
    expect(await joins(ownerLine, owner)).toBe(true);
    expect(await joins(colleagueLine, colleague)).toBe(true);
    world.ollama.resume();
    const [ada, ben] = await Promise.all(asking.map(async (one) => await (await one).rest()));
    if (ada === undefined || ben === undefined) throw new Error('a stream did not end');
    // The n-th request Ollama had was given the n-th words.
    const wordsFor = (asked: string): string =>
      (WORDS[world.ollama.seen.findIndex((seen) => seen.last.includes(asked))] ?? []).join('');
    expect(textOf(ada)).toBe(wordsFor('Ada'));
    expect(textOf(ben)).toBe(wordsFor('Ben'));
    expect(textOf(ada)).not.toBe(textOf(ben));
    expect(replyOf(ada)).toMatchObject({ answered: true, body: wordsFor('Ada') });
    expect(replyOf(ben)).toMatchObject({ answered: true, body: wordsFor('Ben') });
    expect(world.ollama.seen).toHaveLength(2);
    for (const asked of ['Due for Ada?', 'Due for Ben?']) {
      // oxlint-disable-next-line no-await-in-loop -- one question after another
      expect(await callFor(world, asked)).toEqual([
        { state: 'settled', offered: true, requested: true, actual: 0 },
      ]);
    }
  }, 120_000);

  it("another business's call and doorbell admit neither this business's person nor its agent", async () => {
    const owner = await tokenFor(world.w.owner.presented.subject);
    const agent = await tokenFor(world.w.fixture.agent.subject);
    const betaLine = `carry:${beta.id}:call:${beta.callId}`;
    const betaBell = `carry:${beta.id}:agent:${beta.agent.actor}`;
    expect(await joins(betaLine, owner)).toBe(false);
    expect(await joins(betaLine, agent)).toBe(false);
    expect(await joins(betaBell, agent)).toBe(false);
    // Controls: the other business's own owner and agent are admitted to its line.
    const betaOwner = await tokenFor(beta.owner.sub);
    expect(await joins(betaLine, betaOwner)).toBe(true);
    expect(await joins(betaLine, await tokenFor(beta.agent.sub))).toBe(true);
    expect(await joins(betaBell, await tokenFor(beta.agent.sub))).toBe(true);
  }, 60_000);
});
