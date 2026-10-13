// SPDX-License-Identifier: AGPL-3.0-only
//
// One business's paid chat never moves another's budget. Once alpha's owner
// has a paid reply settled and kept, alpha's holds, settlements, refusals and
// a held call leave bravo's budget, envelopes and calls exactly as they were.
// A person listed for alpha is refused in bravo: the list binds the business.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callModelInConversation } from '../../packages/core-custody/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { folded } from '../api/openrouter-stand-in-fixture.ts';
import { HAIKU, HOLD, PAID_KEY, pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('chat budgets keep businesses apart', () => {
  let p: PricedWorld;
  let bravo: string;

  beforeAll(async () => {
    p = await pricedWorld('priced_businesses_apart');
    bravo = await insertBusiness(p.w.fixture.db.app, `bravo-${randomUUID().slice(0, 8)}`);
    await p.setCap(5_000, bravo);
  }, 180_000);

  afterAll(async () => {
    p?.openrouter.open();
    await p?.stop();
  });

  const bravoRows = async () =>
    await p.w.fixture.db.admin.execute(
      `select 'cap' as kind, id::text, limit_minor::text as value from public.budget_caps where business_id = $1
       union all select 'envelope', id::text, cap_id::text from public.planning_envelopes where business_id = $1
       union all select 'call', id::text, state from public.model_calls where business_id = $1
       order by 1, 2`,
      [bravo],
    );

  it("alpha's paid replies, refusals and held calls leave bravo as it was", async () => {
    const first = await p.question('What is due today?');
    expect(await p.ask(first)).toMatchObject({ answered: true });
    const before = await bravoRows();
    expect(before).toHaveLength(1);
    p.openrouter.shut();
    const inFlight = await p.question('What is overdue?');
    const flying = p.ask(inFlight);
    await p.openrouter.arrived(2);
    expect(await bravoRows()).toStrictEqual(before);
    p.openrouter.open();
    await flying;
    p.openrouter.answer = () => folded('openai/gpt-6.1', 'Someone else answered.');
    const mismatched = await p.question('Who is away?');
    expect(await p.ask(mismatched)).toMatchObject({ code: 'LIABILITY_UNKNOWN' });
    await p.setCap(HOLD - 1);
    const refused = await p.question('Anything else?');
    expect(await p.ask(refused)).toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
    expect(await bravoRows()).toStrictEqual(before);
    expect(await p.committed(bravo)).toBe(0);
  });

  it('a person listed for alpha is refused in bravo, before any row', async () => {
    const owner = p.w.owner;
    const result = await callModelInConversation(
      p.w.fixture.db.app,
      bravo,
      { actorId: owner.actorId, delegationId: null, attendedByPersonId: owner.personId },
      {
        conversation: { id: randomUUID(), businessId: bravo, ownerPersonId: owner.personId },
        messageId: randomUUID(),
        operation: PAID_KEY,
        model: HAIKU,
        fields: [{ name: 'message', source: 'outside', value: 'What is due today?' }],
        paid: { authors: [owner.actorId], asCaller: async () => await Promise.resolve(undefined) },
      },
      { ...p.broker, audit: async () => await Promise.resolve() },
    );
    expect(result).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(
      await p.w.count('select count(*)::text as n from public.model_calls where business_id = $1', [
        bravo,
      ]),
    ).toBe(0);
  });
});
