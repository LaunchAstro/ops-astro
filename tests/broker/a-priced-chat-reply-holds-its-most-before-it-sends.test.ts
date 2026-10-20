// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid reply sets aside its most before anything is sent: while OpenRouter
// holds the request, the call is `dispatched` at the operation's most, in the
// conversation's envelope, and the business's committed amount has risen by
// it. Once OpenRouter answers, the call settles at the reported cost, the
// rest is freed, and the reply is kept.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { HOLD, centsOf, pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)(
  'a priced chat reply holds its most before it sends',
  () => {
    let p: PricedWorld;

    beforeAll(async () => {
      p = await pricedWorld('priced_hold_first');
    }, 180_000);

    afterAll(async () => {
      await p?.stop();
    });

    it('holds the most while OpenRouter has the request, then settles at the reported cost', async () => {
      const asked = await p.question('What is due today?');
      const before = await p.committed();
      p.openrouter.shut();
      const reply = p.ask(asked);
      await p.openrouter.arrived(1);
      const [held] = await p.calls(asked.conversationId);
      expect(held).toMatchObject({ state: 'dispatched', reserved_minor: String(HOLD) });
      expect(held?.['planning_envelope_id']).not.toBeNull();
      expect(held?.['conversation_message_id']).toBe(asked.messageId);
      expect(await p.committed()).toBe(before + HOLD);
      p.openrouter.open();
      expect(await reply).toMatchObject({ answered: true, body: 'Two tasks are due today.' });
      const [settled] = await p.calls(asked.conversationId);
      expect(settled).toMatchObject({ state: 'settled', actual_minor: String(centsOf(0.000_3)) });
      expect(await p.committed()).toBe(before + centsOf(0.000_3));
      expect(p.openrouter.received).toHaveLength(1);
    });
  },
);
