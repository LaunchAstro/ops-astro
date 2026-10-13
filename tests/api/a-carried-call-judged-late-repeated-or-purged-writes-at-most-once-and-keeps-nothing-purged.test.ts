// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried call between its offer and its answer, on schedules ordered by
// what Postgres reports waiting:
//
// - The send judgement waits on a lock longer than the send window, then
//   passes with nothing changed: the request it sends is past the agent's
//   deadline, so nothing is written and the call is released.
// - The conversation purged after the offer, before the send judgement: the
//   judgement sees it, nothing is sent. Purged once the send is judged: the
//   purge waits on the judgement's locks until the write is reported, and
//   the answer that follows keeps no reply in the purged conversation.
// - The same message sent again (the same operation id) while its call is
//   offered and waiting for the accept, and while its send judgement waits:
//   one call, one request at Ollama, one reply.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_WINDOW_MS } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';
import type { HeldApp } from './carried-exchange-fixture.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { callFor, holdAgent, judgementWaits, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';
import { sendStreaming, type Streaming } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Kept ', 'once.'];

const outcome = (events: readonly { readonly data: string }[]) =>
  JSON.parse(events.at(-1)?.data ?? '{}') as Record<string, unknown>;

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a carried call judged late, repeated or purged', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_late_repeat_purge');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  /** `conversation.start` with this operation id: the same message each time it is sent. */
  const start = (operationId: string, body: string): Promise<Streaming> =>
    sendStreaming(world.api, world.w.owner, 'conversation.start', { operationId, body });

  /** The conversation of call `k`, purged in a committed transaction of the application role. */
  const purge = async (k: string): Promise<void> => {
    await world.w.fixture.db.app.withBusiness(world.w.fixture.business, async (tx) => {
      await tx.query(
        `update public.conversations v
            set body_purged_at = clock_timestamp(), purge_operation_id = $3
           from public.model_calls c
          where c.business_id = $1 and c.id = $2
            and v.business_id = c.business_id and v.id = c.conversation_id`,
        [tx.businessId, k, randomUUID()],
      );
    });
  };

  const calls = async (body: string): Promise<number> =>
    await world.w.count(
      `select count(*)::text as n from public.model_calls c
         join public.conversation_messages m on m.id = c.conversation_message_id
        where m.body = $1`,
      [body],
    );

  it('a send judgement that passes only after the send window writes nothing', async () => {
    const body = 'Judged late?';
    const holding = latch<HeldApp<void>>();
    world.agent.beforeAccept = async () => {
      holding.open(await holdAgent(world));
    };
    const asking = start(randomUUID(), body);
    const held = await holding.promise;
    await judgementWaits(world, held);
    const since = Date.now();
    while (Date.now() - since <= SEND_WINDOW_MS + 500) {
      // oxlint-disable-next-line no-await-in-loop -- the send window passes while the judgement waits
      await sleep(50);
    }
    await held.letGo();
    const events = await (await asking).rest();
    expect(world.ollama.seen).toHaveLength(0);
    expect(world.agent.sent).toHaveLength(0);
    expect(await callFor(world, body)).toEqual([
      { state: 'released', offered: true, requested: true, actual: null },
    ]);
    expect(outcome(events)).toMatchObject({ reply: { answered: false } });
  }, 60_000);

  it('purged after the offer, before the send: nothing sent, released', async () => {
    const body = 'Purged before the send?';
    world.agent.beforeAccept = purge;
    const events = await (await start(randomUUID(), body)).rest();
    expect(world.ollama.seen).toHaveLength(0);
    expect(await callFor(world, body)).toEqual([
      { state: 'released', offered: true, requested: true, actual: null },
    ]);
    expect(outcome(events)).toMatchObject({ reply: { answered: false } });
  }, 60_000);

  it('purged once the send is judged: the purge waits for the write, and no reply is kept', async () => {
    const body = 'Purged mid-answer?';
    world.agent.mode = 'late-answer';
    const asking = start(randomUUID(), body);
    await world.agent.dispatched(1);
    const [row] = await world.w.fixture.db.admin.execute<{ readonly id: string }>(
      `select c.id::text from public.model_calls c
         join public.conversation_messages m on m.id = c.conversation_message_id
        where m.body = $1`,
      [body],
    );
    await purge(String(row?.id));
    expect(world.ollama.seen).toHaveLength(1);
    world.agent.release();
    const events = await (await asking).rest();
    expect(await repliesTo(world, body)).toBe(0);
    const kept = await world.w.count(
      `select count(*)::text as n from public.conversation_messages a
         join public.conversations v on v.business_id = a.business_id and v.id = a.conversation_id
        where v.body_purged_at is not null and a.role = 'agent'`,
      [],
    );
    expect(kept).toBe(0);
    const said = outcome(events)['reply'] as { readonly answered?: boolean } | null | undefined;
    expect(said?.answered).not.toBe(true);
  }, 60_000);

  it.each(['offered, before the accept', 'in its send judgement'] as const)(
    'the same message sent again while its call is %s: one call, one request, one reply',
    async (moment) => {
      const body = `Sent twice? (${moment})`;
      const operationId = randomUUID();
      const holding = latch<HeldApp<void> | null>();
      const accepting = latch();
      world.agent.beforeAccept = async () => {
        if (moment === 'in its send judgement') holding.open(await holdAgent(world));
        else {
          holding.open(null);
          await accepting.promise;
        }
      };
      const first = start(operationId, body);
      const held = await holding.promise;
      if (held !== null) await judgementWaits(world, held);
      const again = start(operationId, body);
      // The repeat has had its chance to ask: give it the time the first has had.
      await sleep(300);
      expect(await calls(body)).toBe(1);
      accepting.open();
      await held?.letGo();
      const [one, two] = await Promise.all([(await first).rest(), (await again).rest()]);
      expect(world.ollama.seen).toHaveLength(1);
      expect(world.agent.accepted).toHaveLength(1);
      expect(await calls(body)).toBe(1);
      expect(await repliesTo(world, body)).toBe(1);
      expect(outcome(one)).toMatchObject({ reply: { answered: true, body: 'Kept once.' } });
      expect(outcome(two)).toMatchObject({ reply: { answered: true, body: 'Kept once.' } });
    },
    60_000,
  );
});
