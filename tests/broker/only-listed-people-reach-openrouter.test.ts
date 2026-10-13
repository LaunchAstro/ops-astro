// SPDX-License-Identifier: AGPL-3.0-only
//
// Only a person the install lists for this business sends a paid call: the
// broker's own list decides, whatever the offer said. An unlisted owner is
// refused, and so is a listed person's id paired with another business. The
// list matches an id whatever its case.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, scopeOf, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const listing = (people: readonly string[]) => (broker: PricedWorld['broker']) => ({
  ...broker,
  outsidePeople: people,
});

describe.skipIf(serverUrl === undefined)('only listed people reach OpenRouter', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_listed_only');
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('an owner the broker does not list is refused, though the offer listed them', async () => {
    const { db, business } = p.w.fixture;
    const asked = await p.question('What is due today?');
    const sent = p.openrouter.received.length;
    const unlisted = await p.twin(listing([]));
    expect(await unlisted(db.app, business, p.w.owner.presented, asked)).toMatchObject({
      answered: false,
      code: 'LOCAL_MODEL_REQUIRED',
    });
    expect(await p.calls(asked.conversationId)).toHaveLength(0);
    expect(p.openrouter.received.length).toBe(sent);
  });

  it("a listed person's id under another business is refused", async () => {
    const asked = await p.question('What is due today?');
    const sent = p.openrouter.received.length;
    const elsewhere = listing([`${randomUUID()}:${p.w.owner.personId}`]);
    expect(await p.direct(scopeOf(p, asked), undefined, elsewhere)).toMatchObject({
      ok: false,
      code: 'LOCAL_MODEL_REQUIRED',
    });
    expect(await p.calls(asked.conversationId)).toHaveLength(0);
    expect(p.openrouter.received.length).toBe(sent);
  });

  it('control: the pair listed in capitals is the same pair', async () => {
    const asked = await p.question('What is due today?');
    const upper = listing([`${p.w.fixture.business}:${p.w.owner.personId}`.toUpperCase()]);
    expect(await p.direct(scopeOf(p, asked), undefined, upper)).toMatchObject({ ok: true });
  });
});
