// SPDX-License-Identifier: AGPL-3.0-only
//
// What never reaches the side panel's stream as a piece: words Ollama writes
// after the line that ends its answer, an error body, and any answer to a
// request custody sent with a credential it presents. Each still ends in one
// outcome, last, saying what was kept.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';
import { sendStreaming, type StreamEvent } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const MODEL = 'qwen3.6:27b-mlx';
const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today.'];

const piecesOf = (events: readonly StreamEvent[]): string =>
  events
    .filter((event) => event.event === 'piece')
    .map((event) => event.data)
    .join('');

const outcomeOf = (events: readonly StreamEvent[]): Record<string, unknown> => {
  const last = events.at(-1);
  expect(last?.event).toBe('outcome');
  return JSON.parse(last?.data ?? '{}') as Record<string, unknown>;
};

/** A line Ollama never writes after its last: more words once the answer is done. */
const after = (content: string): string =>
  `${JSON.stringify({ model: MODEL, message: { role: 'assistant', content }, done: false })}\n`;

describe.skipIf(serverUrl === undefined)(
  'no piece from past the end, an error or a presented credential',
  // oxlint-disable-next-line max-lines-per-function -- one stand-in, two brokers and two worlds
  () => {
    let ollama: StandIn;
    let none: Awaited<ReturnType<typeof ollamaBroker>>;
    let token: Awaited<ReturnType<typeof ollamaBroker>>;
    let w: ConversationWorld;
    let presenting: ConversationWorld;

    beforeAll(async () => {
      vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
      ollama = await standInOllama();
      none = await ollamaBroker(ollama.origin, 'none');
      token = await ollamaBroker(ollama.origin, 'token');
      const fixture = await createApiFixture('no_piece_past_end');
      w = await conversationWorld({ fixture, api: composedWith(fixture, none.exchange) });
      const second = await createApiFixture('no_piece_presented');
      presenting = await conversationWorld({
        fixture: second,
        api: composedWith(second, token.exchange),
      });
    }, 240_000);

    afterAll(async () => {
      await none?.stop();
      await token?.stop();
      await ollama?.close();
      await w?.drop();
      await presenting?.drop();
      vi.unstubAllEnvs();
    });

    it('words after the done line are never a piece', async () => {
      ollama.reply = (model) => ({
        status: 200,
        chunks: [...streamedLines(model, WORDS), after(' canary-after-done-4c1e')],
      });
      const events = await (
        await sendStreaming(w.api, w.owner, 'conversation.start', { body: 'What is due?' })
      ).rest();
      expect(piecesOf(events)).not.toContain('canary-after-done-4c1e');
      expect(outcomeOf(events)).toMatchObject({ reply: { answered: false } });
    });

    it('an error body is never a piece', async () => {
      ollama.reply = () => ({ status: 500, chunks: ['{"error":"canary-error-body-77d0"}\n'] });
      const events = await (
        await sendStreaming(w.api, w.owner, 'conversation.start', { body: 'What is due?' })
      ).rest();
      expect(piecesOf(events)).toBe('');
      expect(JSON.stringify(events)).not.toContain('canary-error-body-77d0');
      expect(outcomeOf(events)).toMatchObject({ reply: { answered: false } });
    });

    it('an answer past the byte limit: pieces stop within it, the outcome is last and keeps nothing', async () => {
      const words = Array.from({ length: 3_000 }, (_, at) => `w${String(at)} `);
      ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, words) });
      const events = await (
        await sendStreaming(w.api, w.owner, 'conversation.start', { body: 'Say a lot.' })
      ).rest();
      const shown = piecesOf(events);
      expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(256 * 1024);
      expect(shown).not.toContain('w2999');
      expect(outcomeOf(events)).toMatchObject({ reply: { answered: false } });
      expect(events.filter((event) => event.event === 'outcome')).toHaveLength(1);
      const replies = await w.count(
        `select count(*)::text as n from public.conversation_messages m
         join public.conversation_messages q on q.id = m.answers_message_id
        where q.body = 'Say a lot.'`,
        [],
      );
      expect(replies).toBe(0);
    });

    it('a presented credential asks for the answer whole: no piece, and the reply still comes', async () => {
      // As Ollama answers: whole when asked whole.
      ollama.reply = (model) =>
        (JSON.parse(ollama.seen.at(-1)?.raw ?? '{}') as { stream?: boolean }).stream === true
          ? { status: 200, chunks: streamedLines(model, WORDS) }
          : {
              status: 200,
              chunks: [
                JSON.stringify({
                  model,
                  message: { role: 'assistant', content: WORDS.join('') },
                  done: true,
                  prompt_eval_count: 1,
                  eval_count: 1,
                }),
              ],
            };
      const events = await (
        await sendStreaming(presenting.api, presenting.owner, 'conversation.start', {
          body: 'What is due?',
        })
      ).rest();
      expect(ollama.seen.at(-1)?.authorization).toMatch(/^Bearer /u);
      expect(JSON.parse(ollama.seen.at(-1)?.raw ?? '{}')).toMatchObject({ stream: false });
      expect(piecesOf(events)).toBe('');
      expect(outcomeOf(events)).toMatchObject({
        reply: { answered: true, body: 'Two tasks are due today.' },
      });
    });

    it('a presented credential answered with a stream anyway keeps nothing and shows nothing', async () => {
      ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
      const events = await (
        await sendStreaming(presenting.api, presenting.owner, 'conversation.start', {
          body: 'Streamed anyway?',
        })
      ).rest();
      expect(piecesOf(events)).toBe('');
      expect(outcomeOf(events)).toMatchObject({ reply: { answered: false } });
      const replies = await w.count(
        `select count(*)::text as n from public.conversation_messages m
         join public.conversation_messages q on q.id = m.answers_message_id
        where q.body = 'Streamed anyway?'`,
        [],
      );
      expect(replies).toBe(0);
    });
  },
);
