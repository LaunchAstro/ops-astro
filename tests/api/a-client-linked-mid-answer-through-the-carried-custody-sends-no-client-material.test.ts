// SPDX-License-Identifier: AGPL-3.0-only
//
// A client linked to a carried conversation's page task while its question is
// answered. What went to Ollama was an internal task's title, sent before the
// link could commit: a link that comes while the send judgement holds the
// page task's row waits for the write (or the send window, when no write is
// reported), and one that comes once the write is reported commits at once.
// The answer to the internal question is kept. From the link on, the agent's
// membership is closed and the next question asks no model.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';
import { sendStreaming } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'steps ', 'are ', 'left.'];

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a client linked mid-answer, carried', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_client_link');
    await world.w.fixture.db.app.withBusiness(world.w.fixture.business, async (tx) => {
      await grantTo(tx, world.w.owner, 'share');
    });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  /** An internal task, and how to link a client to it as the person does, timed. */
  async function aTask(title: string) {
    const { w } = world;
    const made = await w.as(w.owner, 'task.create', { fields: { title } });
    const task = String(made.body['recordId']);
    const client = randomUUID();
    await addClient(w.fixture.db.app, w.fixture.business, client, w.owner);
    const link = async (): Promise<number> => {
      const from = Date.now();
      const linked = await w.as(w.owner, 'task.set_party', {
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: made.body['revision'],
        fields: { client },
      });
      expect(linked.status).toBe(200);
      return Date.now() - from;
    };
    return { task, link };
  }

  it.each([
    ['while the send judgement holds the page task', 2_000, 6_000],
    ['once the write is reported', 0, 1_500],
  ] as const)(
    'a link %s: the internal question is answered, then no model is asked',
    async (when, least, most) => {
      const held = least > 0;
      world.ollama.reply = (model) => ({
        status: 200,
        chunks: streamedLines(model, WORDS),
        ...(held ? {} : { holdAfter: 1 }),
      });
      // Held: Ollama answers nothing, not even its headers, so no write is reported.
      if (held) world.ollama.shut();
      const title = `Internal for now ${randomUUID()}`;
      const { task, link } = await aTask(title);
      const body = `What is left? (${when})`;
      const asking = ask(world, body, undefined, task);
      if (held) await world.ollama.arrived(1);
      else await world.ollama.midway();
      const waited = await link();
      expect(waited).toBeGreaterThanOrEqual(least);
      expect(waited).toBeLessThan(most);
      // What went out was the internal task's title, asked before the link, never its id.
      expect(world.ollama.seen).toHaveLength(1);
      expect(world.ollama.seen[0]?.raw).toContain(title);
      expect(world.ollama.seen[0]?.raw).not.toContain(task);
      if (held) world.ollama.open();
      else world.ollama.resume();
      const events = await (await asking).rest();
      expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({
        reply: { answered: true, body: WORDS.join('') },
      });
      expect(await repliesTo(world, body)).toBe(1);
      // From the link on: the membership is closed and the next question asks no model.
      const [conversation] = await world.w.fixture.db.admin.execute<{
        readonly id: string;
        readonly open: boolean;
      }>(
        `select c.id, exists (select 1 from public.conversation_agent_members m
                               where m.conversation_id = c.id and m.left_at is null) as open
           from public.conversations c where c.scope_record_id = $1`,
        [task],
      );
      expect(conversation?.open).toBe(false);
      const later = await sendStreaming(world.api, world.w.owner, 'conversation.message', {
        conversationId: conversation?.id,
        body: 'And now?',
      });
      const ended = await later.rest();
      expect(JSON.parse(ended.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
      expect(world.ollama.seen).toHaveLength(1);
      expect(world.agent.sent).toHaveLength(1);
    },
    120_000,
  );
});
