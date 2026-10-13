// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid answer that names a model other than the one asked, with a valid
// cost, is held at the most with the observed cost recorded and the mismatch
// named; no reply is kept, and the panel says the cost stays set aside. An
// answer naming the asked model's dated id settles as the model itself does.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { HAIKU_DATED, folded } from '../api/openrouter-stand-in-fixture.ts';
import { HOLD, centsOf, pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a paid answer from another model', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_model_match');
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  const replies = async (conversationId: string): Promise<number> =>
    await p.w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  it('held at the most, the observed cost recorded, nothing kept', async () => {
    p.openrouter.answer = () => folded('openai/gpt-6.1', 'Two tasks are due today.', 0.002);
    const asked = await p.question('What is due today?');
    const reply = await p.ask(asked);
    expect(reply).toMatchObject({ answered: false, code: 'LIABILITY_UNKNOWN' });
    expect(reply && !reply.answered ? reply.words : '').toContain('AUD 0.25 stays set aside');
    const [call] = await p.calls(asked.conversationId);
    expect(call).toMatchObject({
      state: 'liability_unknown',
      reserved_minor: String(HOLD),
      observed_minor: String(centsOf(0.002)),
      provider_code: 'model_mismatch',
    });
    expect(await replies(asked.conversationId)).toBe(0);
  });

  it("control: the asked model's dated id settles and keeps the reply", async () => {
    p.openrouter.answer = () => folded(HAIKU_DATED, 'Two tasks are due today.');
    const asked = await p.question('What is due today?');
    expect(await p.ask(asked)).toMatchObject({ answered: true });
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'settled' }]);
    expect(await replies(asked.conversationId)).toBe(1);
  });
});
