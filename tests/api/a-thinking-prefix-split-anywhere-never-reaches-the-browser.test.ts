// SPDX-License-Identifier: AGPL-3.0-only
//
// A model that opens its answer with a thinking block, streamed in chunks cut
// anywhere (inside the `<think>` tag, inside a JSON line, inside a character):
// the browser's pieces carry none of the thinking and none of the stream's
// own format, only the answer's words, and the settled reply is the answer
// alone.

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
import { sendStreaming } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const THOUGHT = 'hidden-thought-91be';
const WORDS = ['<th', 'ink>', `I should ${THOUGHT} first.`, '</th', 'ink>\n', 'Two ', 'tasks ✓.'];

/** The stream's text cut into pieces of `size` bytes, wherever that falls. */
function cutEvery(text: string, size: number): string[] {
  const bytes = Buffer.from(text);
  const chunks: string[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    chunks.push(bytes.subarray(at, at + size).toString('latin1'));
  }
  return chunks;
}

describe.skipIf(serverUrl === undefined)('a thinking prefix split anywhere', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('thinking_prefix_split');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  it.each([1, 3, 7, 50])(
    'cut every %i bytes: pieces hold only the answer, and the reply is the answer',
    async (size) => {
      ollama.reply = (model) => ({
        status: 200,
        // Latin-1 round-trips each byte, so a character cut in two stays cut in two on the wire.
        chunks: cutEvery(streamedLines(model, WORDS).join(''), size),
        latin1: true,
      });
      const streaming = await sendStreaming(w.api, w.owner, 'conversation.start', {
        body: 'What is due today?',
      });
      const events = await streaming.rest();
      const pieces = events.filter((event) => event.event === 'piece').map((event) => event.data);
      expect(pieces.join('')).toBe('Two tasks ✓.');
      const outcome = events.at(-1);
      expect(JSON.parse(outcome?.data ?? '{}')).toMatchObject({
        reply: { answered: true, body: 'Two tasks ✓.' },
      });
      const all = JSON.stringify(events);
      expect(all).not.toContain(THOUGHT);
      expect(all).not.toContain('think');
      expect(all).not.toContain('"done"');
    },
    60_000,
  );
});
