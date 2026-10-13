// SPDX-License-Identifier: AGPL-3.0-only
//
// What OpenRouter receives for a paid reply is the pinned request, with the
// key custody presents as a bearer token, and the key reaches nothing on the
// API's side: not its environment, not the reply, not the rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { BEARER, HAIKU, pricedWorld, type PricedWorld } from '../broker/priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the request OpenRouter receives', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_pinned', undefined, 1, true);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it("is pinned, carries custody's bearer key, and the key stays in custody", async () => {
    const asked = await p.question('What is due today?');
    const reply = await p.ask(asked);
    expect(reply).toMatchObject({ answered: true });
    const [received] = p.openrouter.received;
    expect(received?.path).toBe('/api/v1/chat/completions');
    expect(received?.authorization).toBe(`Bearer ${BEARER}`);
    expect(Object.keys(received?.body ?? {}).toSorted()).toStrictEqual([
      'max_tokens',
      'messages',
      'model',
      'provider',
      'stream',
      'usage',
    ]);
    expect(received?.body).toMatchObject({
      model: HAIKU,
      max_tokens: 2_048,
      provider: { max_price: { prompt: '0.1', completion: '0.5' }, allow_fallbacks: false },
    });
    expect(received?.body).not.toHaveProperty('models');
    expect(received?.body).not.toHaveProperty('route');
    expect(JSON.stringify(process.env)).not.toContain(BEARER);
    expect(JSON.stringify(reply)).not.toContain(BEARER);
    const rows = await p.calls(asked.conversationId);
    expect(JSON.stringify(rows)).not.toContain(BEARER);
  });
});
