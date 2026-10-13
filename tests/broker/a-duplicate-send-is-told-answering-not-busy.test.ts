// SPDX-License-Identifier: AGPL-3.0-only
//
// With the paid route at one call at a time and a call in flight, the same
// message sent again (from another instance) is told its answer is on its
// way, never that the model is busy: the message's call is looked up before
// the ceiling is asked. A different message is told the model is busy. Either
// way nothing is written, held or sent.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a duplicate send while the ceiling is full', () => {
  let p: PricedWorld;
  let twin: ConversationExchange;

  beforeAll(async () => {
    p = await pricedWorld('priced_duplicate_answering');
    twin = await p.twin();
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('the same message: answering; another message: busy; nothing written or sent', async () => {
    const { db, business } = p.w.fixture;
    const asked = await p.question('What is due today?');
    const other = await p.question('Who is away this week?');
    p.openrouter.shut();
    const first = p.ask(asked);
    await p.openrouter.arrived(1);
    const before = await p.committed();
    expect(await twin(db.app, business, p.w.owner.presented, asked)).toMatchObject({
      answered: false,
      code: 'STILL_ANSWERING',
    });
    expect(await twin(db.app, business, p.w.owner.presented, other)).toMatchObject({
      answered: false,
      code: 'RATE_LIMITED',
    });
    expect(await p.calls(asked.conversationId)).toHaveLength(1);
    expect(await p.calls(other.conversationId)).toHaveLength(0);
    expect(await p.committed()).toBe(before);
    expect(p.openrouter.received).toHaveLength(1);
    p.openrouter.open();
    expect(await first).toMatchObject({ answered: true });
  });
});
