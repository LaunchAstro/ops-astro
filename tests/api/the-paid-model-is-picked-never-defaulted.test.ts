// SPDX-License-Identifier: AGPL-3.0-only
//
// The paid model is used only when the person picks it. A new conversation
// with no choice answers on the free model, nothing sent to OpenRouter. A
// person not on the outside list cannot start a conversation on the paid
// model or move one to it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import { HAIKU, pricedWorld, type PricedWorld } from '../broker/priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the paid model is picked, never defaulted', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_never_default');
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('a new conversation with no choice answers on the free model', async () => {
    const opened = detail(await p.w.as(p.w.owner, 'conversation.start', { body: 'What is due?' }));
    const heard = p.ollama.seen.length;
    const reply = await p.ask({
      conversationId: String(opened['conversationId']),
      messageId: String(opened['messageId']),
    });
    expect(reply).toMatchObject({ answered: true });
    expect(p.ollama.seen.length).toBe(heard + 1);
    expect(p.openrouter.received).toHaveLength(0);
  });

  it('an unlisted person cannot start on the paid model or move to it', async () => {
    const start = await p.w.as(p.w.colleague, 'conversation.start', { body: 'Hi', model: HAIKU });
    expect(start.status).toBe(422);
    const own = detail(await p.w.as(p.w.colleague, 'conversation.start', { body: 'Hi' }));
    const set = await p.w.as(p.w.colleague, 'conversation.set_model', {
      conversationId: own['conversationId'],
      model: HAIKU,
    });
    expect(set.status).toBe(422);
    expect(p.openrouter.received).toHaveLength(0);
  });
});
