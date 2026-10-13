// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid answer streams like Ollama's: custody decodes OpenRouter's events
// and the panel hears the first words while OpenRouter is still writing,
// once they pass what custody holds back (the key's longest spelling).
// Once it ends, the call settles at the reported cost and the reply kept is
// the pieces joined.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { sse } from './openrouter-stand-in-fixture.ts';
import { HAIKU, centsOf, pricedWorld, type PricedWorld } from '../broker/priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a paid answer streams through custody', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_streams', undefined, 1, true);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('the first words arrive while OpenRouter writes; the reply is the pieces, settled', async () => {
    const long = 'Two tasks are due today, and both are small enough to finish this morning. ';
    const words = [long.repeat(2), long.repeat(2), 'Then lunch.', ' Done.'];
    p.openrouter.answer = () => ({ status: 200, chunks: sse(HAIKU, words), holdAfter: 3 });
    const asked = await p.question('What is due today?');
    const heard: string[] = [];
    const { db, business } = p.w.fixture;
    const answering = p.exchange(db.app, business, p.w.owner.presented, asked, (text) =>
      heard.push(text),
    );
    await p.openrouter.midway();
    for (let tries = 0; tries < 300 && heard.join('') === ''; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the first piece to cross custody
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(heard.join('')).not.toBe('');
    expect(words.join('').startsWith(heard.join(''))).toBe(true);
    p.openrouter.resume();
    const reply = await answering;
    expect(reply).toMatchObject({ answered: true, body: words.join('') });
    expect(heard.join('')).toBe(words.join(''));
    expect(await p.calls(asked.conversationId)).toMatchObject([
      { state: 'settled', actual_minor: String(centsOf(0.000_3)) },
    ]);
  });
});
