// SPDX-License-Identifier: AGPL-3.0-only
//
// Ollama runs one model at a time on the M5, so its conversation operation
// declares one call at a time per business (`OLLAMA_CONVERSATION.concurrency`).
// Two people's questions, in two conversations of one business, reach the
// conversation seam's limit at the same instant: both are seen waiting on the
// limit's lock in `pg_stat_activity` before either goes on. Exactly one
// reaches the stand-in Ollama; the other is answered in fixed words (the model
// is busy) at once, its message kept and no reply kept, while the first is
// still with the model. Nothing hangs, and the busy question asked again once
// the first is answered gets its own answer.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { CONVERSATION_ANSWER } from '../../packages/core-connectors/src/index.ts';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import { ollamaBroker, says, standInOllama, type StandIn } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const QWEN = 'qwen3.6:35b-mlx';

/** Rejects after `ms`, so a case that would hang fails instead. */
const within = async <T>(ms: number, work: Promise<T>): Promise<T> =>
  await Promise.race([
    work,
    sleep(ms).then(() => {
      throw new Error(`still waiting after ${String(ms)} ms`);
    }),
  ]);

// eslint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('two Ollama questions at the same instant', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin);
    // The API answers nothing; the case calls the exchange on connections of its own.
    const fixture = await createApiFixture('ollama_busy_race');
    w = await conversationWorld({
      fixture,
      api: composedWith(fixture, async () => await Promise.resolve(null)),
    });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  /** A conversation with one person's question kept and not yet answered. */
  async function question(body: string) {
    const opened = await w.as(w.owner, 'conversation.start', { body });
    return {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
  }

  /** Waits until `n` backends wait on a lock the backend `pid` holds. */
  async function waitingOn(pid: number, n: number): Promise<void> {
    for (let tries = 0; tries < 500; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const found = await w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and $1::int = any(pg_blocking_pids(pid))`,
        [pid],
      );
      if (found >= n) return;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await sleep(10);
    }
    throw new Error(`${String(n)} backends never waited on the limit's lock`);
  }

  // eslint-disable-next-line max-lines-per-function -- one schedule, its checks and its clean-up
  it('one question reaches the model, the other is told the model is busy, and nothing hangs', async () => {
    const { db, business } = w.fixture;
    const first = await question('What is due today?');
    const second = await question('And this week?');
    // The seam's own limit lock, held so both questions arrive at it together.
    const limit = `limit:${business}:model_call:${CONVERSATION_ANSWER.key}`;
    const holder = await hold(db, async (execute) => {
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [limit]);
    });
    const readers = [0, 1].map(() => connect(db.appUrl, { source: 'runtime' }));
    ollama.shut();
    const asking: Promise<ConversationReply | null>[] = [];
    try {
      asking.push(
        broker.exchange(readers[0]!, business, w.owner.presented, first),
        broker.exchange(readers[1]!, business, w.owner.presented, second),
      );
      await waitingOn(holder.pid, 2);
      await holder.letGo();
      // The refused one answers while the other is still with the model.
      const [refusedAt, refused] = await within(
        10_000,
        Promise.race(asking.map(async (one, at) => [at, await one] as const)),
      );
      expect(refused).toMatchObject({ answered: false, code: 'RATE_LIMITED' });
      expect(refused).toHaveProperty('words', expect.stringContaining('The model is busy'));
      await ollama.arrived(1);
      expect(ollama.seen).toHaveLength(1);
      ollama.open();
      const answeredAt = 1 - refusedAt;
      const reply = await within(10_000, asking[answeredAt]!);
      expect(reply).toMatchObject({ answered: true, body: says(QWEN) });
      expect(ollama.seen).toHaveLength(1);
      const asked = [first, second];
      expect(ollama.seen[0]?.last).toBe(answeredAt === 0 ? 'What is due today?' : 'And this week?');
      // Each person's message kept; one reply in all, on the question that was answered.
      for (const [at, one] of asked.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- two conversations, read in turn
        const roles = await db.admin.execute<{ readonly role: string }>(
          `select role from public.conversation_messages where conversation_id = $1 order by created_at`,
          [one.conversationId],
        );
        expect(roles.map((row) => row.role)).toStrictEqual(
          at === answeredAt ? ['person', 'agent'] : ['person'],
        );
      }
      const calls = await db.admin.execute<{ readonly conversation_id: string; state: string }>(
        `select conversation_id::text, state from public.model_calls
          where conversation_id = any($1::uuid[])`,
        [asked.map((one) => one.conversationId)],
      );
      expect(calls).toEqual([
        { conversation_id: asked[answeredAt]!.conversationId, state: 'settled' },
      ]);
      // Asked again once the model is free, the busy question gets its own answer.
      const again = await within(
        10_000,
        broker.exchange(readers[refusedAt]!, business, w.owner.presented, asked[refusedAt]!),
      );
      expect(again).toMatchObject({ answered: true, body: says(QWEN) });
      expect(ollama.seen).toHaveLength(2);
    } finally {
      ollama.open();
      await holder.letGo();
      await Promise.allSettled(asking);
      await Promise.allSettled(readers.map(async (one) => await one.close()));
    }
  }, 60_000);

  it('a question while another is with the model is told at once, and holds no call', async () => {
    const { db, business } = w.fixture;
    const busy = await question('Draft the week');
    const waiting = await question('Anything overdue?');
    const before = ollama.seen.length;
    ollama.shut();
    const reader = connect(db.appUrl, { source: 'runtime' });
    let asking: Promise<ConversationReply | null> | undefined;
    try {
      asking = broker.exchange(reader, business, w.owner.presented, busy);
      await ollama.arrived(before + 1);
      // The model has the first question in hand; the second comes now through the API's pool.
      const told = await within(
        10_000,
        broker.exchange(db.app, business, w.owner.presented, waiting),
      );
      expect(told).toMatchObject({ answered: false, code: 'RATE_LIMITED' });
      expect(ollama.seen).toHaveLength(before + 1);
      expect(
        await w.count(
          `select count(*)::text as n from public.model_calls where conversation_id = $1`,
          [waiting.conversationId],
        ),
      ).toBe(0);
      ollama.open();
      expect(await within(10_000, asking)).toMatchObject({ answered: true });
    } finally {
      ollama.open();
      await asking?.catch(() => null);
      await reader.close();
    }
  }, 60_000);
});
