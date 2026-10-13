// SPDX-License-Identifier: AGPL-3.0-only
//
// Each read-then-write on the paid path is scoped to the business and the
// person it was asked for:
//
//   (a) a colleague in the same business presenting the owner's message:
//       nothing read, no row, nothing sent;
//   (b) the owner presenting the message's ids in another business: the same;
//   (c) the conversation handed to the colleague while the answer is out: no
//       reply is kept in it, and the call holds its most with the price seen;
//   (d) the conversation moved to another page between the hold and the
//       send: nothing sent, the call released.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { HOLD, pricedWorld, type PricedWorld } from './priced-chat-world.ts';
import { repliesOf, steppedCustody } from './paid-schedule-support.ts';

const serverUrl = databaseUrlFromEnvironment();

// oxlint-disable-next-line max-lines-per-function -- one world, a schedule per step that reads a scope
describe.skipIf(serverUrl === undefined)('each paid step reads only its own scope', () => {
  let p: PricedWorld;
  let bravo: string;

  beforeAll(async () => {
    p = await pricedWorld('priced_scopes');
    bravo = await insertBusiness(p.w.fixture.db.app, `bravo-${randomUUID().slice(0, 8)}`);
  }, 180_000);

  afterAll(async () => {
    p?.openrouter.open();
    await p?.stop();
  });

  const nothingWritten = async (conversationId: string, sent: number): Promise<void> => {
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.calls(conversationId)).toHaveLength(0);
    expect(await repliesOf(p, conversationId)).toHaveLength(0);
  };

  it("(a) a colleague presenting the owner's message: nothing", async () => {
    const asked = await p.question('What is due today?');
    const sent = p.openrouter.received.length;
    expect(await p.ask(asked, p.w.colleague)).toBeNull();
    expect(
      await p.ask({ ...asked, conversationId: asked.conversationId.toUpperCase() }, p.w.colleague),
    ).toBeNull();
    await nothingWritten(asked.conversationId, sent);
  });

  it("(b) the owner presenting the message's ids in another business: nothing", async () => {
    const { db } = p.w.fixture;
    const asked = await p.question('Who is away this week?');
    const sent = p.openrouter.received.length;
    expect(await p.exchange(db.app, bravo, p.w.owner.presented, asked)).toBeNull();
    await nothingWritten(asked.conversationId, sent);
    expect(
      await p.w.count('select count(*)::text as n from public.model_calls where business_id = $1', [
        bravo,
      ]),
    ).toBe(0);
  });

  it('(c) handed to the colleague while the answer is out: nothing kept, the most held', async () => {
    const { db } = p.w.fixture;
    const asked = await p.question('What is overdue?');
    p.openrouter.onReceipt = async () => {
      await db.admin.execute(
        `update public.conversations set owner_actor_id = $2, owner_person_id = $3 where id = $1`,
        [asked.conversationId, p.w.colleague.actorId, p.w.colleague.personId],
      );
    };
    try {
      expect(await p.ask(asked)).toMatchObject({ answered: false });
    } finally {
      p.openrouter.onReceipt = undefined;
    }
    expect(await repliesOf(p, asked.conversationId)).toHaveLength(0);
    const [call] = await p.calls(asked.conversationId);
    expect(call).toMatchObject({ state: 'liability_unknown', reserved_minor: String(HOLD) });
    expect(call?.['observed_minor']).not.toBeNull();
  });

  it('(d) moved to another page between the hold and the send: nothing sent, released', async () => {
    const { db, business } = p.w.fixture;
    const asked = await p.question('What changed today?');
    const made = await p.w.as(p.w.owner, 'task.create', { fields: { title: 'Another page' } });
    const sent = p.openrouter.received.length;
    const before = await p.committed();
    const exchange = await p.twin(
      steppedCustody(async () => {
        await db.admin.execute(
          `update public.conversations set scope_kind = 'task', scope_record_id = $2 where id = $1`,
          [asked.conversationId, made.body['recordId']],
        );
      }),
    );
    expect(await exchange(db.app, business, p.w.owner.presented, asked)).toMatchObject({
      answered: false,
      code: 'CUSTODY_NOT_ADMITTED',
    });
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'released' }]);
    expect(await p.committed()).toBe(before);
  });
});
