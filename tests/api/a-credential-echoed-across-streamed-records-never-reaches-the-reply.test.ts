// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  chatAnswer,
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('a credential echoed across streamed records', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let world: ConversationWorld;
  let canary = '';

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'token');
    const fixture = await createApiFixture('echoed_credential_records');
    world = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
    // Follows the adapter's own stream setting, whichever it is.
    // Only the provider sees the credential, and echoes it across two content records.
    ollama.reply = (model) => {
      const request = ollama.seen.at(-1);
      canary = (request?.authorization ?? '').replace(/^Bearer /u, '');
      const streamed = (JSON.parse(request?.raw ?? '{}') as { stream?: boolean }).stream;
      return streamed
        ? {
            status: 200,
            chunks: streamedLines(model, ['Echo: ', canary.slice(0, 6), canary.slice(6)]),
          }
        : chatAnswer(model, `Echo: ${canary}`);
    };
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await world?.drop();
    vi.unstubAllEnvs();
  });

  it('a credential echoed across Ollama records never reaches the reply', async () => {
    const result = await world.as(world.owner, 'conversation.start', { body: 'What is due?' });
    expect(canary.length).toBeGreaterThanOrEqual(8);
    expect(result.body).toMatchObject({ reply: { answered: true } });
    const stored = await world.fixture.db.admin.execute<{ body: string }>(
      "select body from public.conversation_messages where role = 'agent'",
    );
    expect(stored).toHaveLength(1);
    expect(JSON.stringify({ result: result.body, stored })).not.toContain(canary);
  }, 60_000);
});
