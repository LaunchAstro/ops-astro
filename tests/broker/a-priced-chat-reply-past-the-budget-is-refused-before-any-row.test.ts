// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid reply the AI chat budget has no room for is refused before anything
// is written or sent, and the person is told what is left. With exactly the
// room for its most, the same reply holds and is answered.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { HOLD, pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a paid reply past the budget', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_past_budget');
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('one cent short: refused with what is left, no row, no request', async () => {
    await p.setCap(HOLD - 1);
    const asked = await p.question('What is due today?');
    const reply = await p.ask(asked);
    expect(reply).toMatchObject({ answered: false, code: 'BUDGET_UNAVAILABLE' });
    expect(reply && 'words' in reply ? reply.words : '').toContain('AUD 0.24 left');
    expect(await p.calls(asked.conversationId)).toHaveLength(0);
    expect(p.openrouter.received).toHaveLength(0);
  });

  it('exactly the room: holds and is answered', async () => {
    await p.setCap(HOLD + (await p.committed()));
    const asked = await p.question('And tomorrow?');
    expect(await p.ask(asked)).toMatchObject({ answered: true });
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'settled' }]);
    expect(p.openrouter.received).toHaveLength(1);
  });
});
