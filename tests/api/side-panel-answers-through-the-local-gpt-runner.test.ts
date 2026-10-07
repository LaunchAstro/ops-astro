// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 end to end on the laptop, one command: `pnpm local-agent` starts the
// runner and writes the API's settings; the API's own composition root reads
// them (brokerSettings, startModelBroker) and the side panel's message is
// answered by `codex exec` through custody and the runner. Here the binary is
// the fake and the database a fresh Postgres; nothing reaches a model.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brokerSettings, startModelBroker } from '../../apps/api/model-broker.ts';
import { startStack, type Stack } from '../../apps/local-agent/stack.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { makeWorld, sourced, type World } from '../local-agent/world.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one stack, set up and asked in one case
describe.skipIf(serverUrl === undefined)('the side panel on the local GPT runner', () => {
  let laptop: World;
  let stack: Stack;
  let stopBroker: () => Promise<void>;
  let w: ConversationWorld;

  beforeAll(async () => {
    laptop = makeWorld();
    laptop.knobs({ text: 'Two tasks are due today.' });
    const started = await startStack(laptop.env, laptop.userHome, () => null);
    if (!started.ok) throw new Error(started.code);
    stack = started.stack;
    const settings = brokerSettings(sourced(stack.apiEnvFile));
    if (settings.kind !== 'configured') throw new Error(`broker ${settings.kind}`);
    const broker = await startModelBroker(settings);
    stopBroker = broker.stop;
    const fixture = await createApiFixture('local_gpt_side_panel');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.answerConversation) });
  }, 180_000);

  afterAll(async () => {
    await stopBroker?.();
    await stack?.close();
    await w?.drop();
    laptop?.remove();
  });

  it("answers the owner's message with codex's reply, kept as the agent's reply", async () => {
    const question = `What is due today? ${randomUUID()}`;
    const opened = await w.as(w.owner, 'conversation.start', { body: question });
    expect(opened.status).toBe(200);
    expect((opened.body as Record<string, unknown>)['reply']).toMatchObject({
      answered: true,
      body: 'Two tasks are due today.',
    });
    expect(laptop.calls().map((call) => call.stdin)).toEqual([question]);
    // One call: charged as unknown before codex ran, then what it used, under one id.
    const ids = new Set(laptop.ledger().map((row) => row['id']));
    expect(ids.size).toBe(1);
    expect(laptop.ledger().at(-1)).toMatchObject({ inputTokens: 120, outputTokens: 7 });
    const [row] = await w.fixture.db.admin.execute<Record<string, unknown>>(
      `select route_reach, credential_kind, provider, state from public.model_calls
        where conversation_id is not null`,
      [],
    );
    expect(row).toMatchObject({
      route_reach: 'local',
      credential_kind: 'subscription',
      provider: 'local_gpt',
    });
  });
});
