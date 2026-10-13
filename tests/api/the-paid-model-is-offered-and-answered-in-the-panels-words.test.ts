// SPDX-License-Identifier: AGPL-3.0-only
//
// The picker, a new conversation and a change of model agree on who is
// offered the paid model: a listed person on a page with no client, by its
// label. An unlisted person, or a conversation on a client's task, is offered
// none. The panel's words for a paid reply say what is left, what is set
// aside, that an answer is on its way, and that a send was not admitted;
// none says chat must cost nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  budgetWith,
  heldWith,
  refusedWith,
  releasedWith,
} from '../../packages/core-commands/src/commands/conversation-replies.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { detail } from './aw-03-fixture.ts';
import { HAIKU, pricedWorld, type PricedWorld } from '../broker/priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const words = (reply: ReturnType<typeof refusedWith>): string =>
  reply.answered ? '' : reply.words;

const offered = (answer: { body: unknown }): readonly { id: string; label?: string }[] =>
  (answer.body as { models: { id: string; label?: string }[] }).models;

describe.skipIf(serverUrl === undefined)("the paid model in the panel's words", () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_offer_words');
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('a listed person on a page with no client: offered by its label, startable and settable', async () => {
    const read = offered(await p.w.as(p.w.owner, 'conversation.models', {}));
    expect(read.find((model) => model.id === HAIKU)?.label).toBe(
      'Claude Haiku 5.5 (paid, internal only)',
    );
    expect(read[0]?.id).not.toBe(HAIKU);
    const opened = detail(await p.w.as(p.w.owner, 'conversation.start', { body: 'Hi' }));
    const set = await p.w.as(p.w.owner, 'conversation.set_model', {
      conversationId: opened['conversationId'],
      model: HAIKU,
    });
    expect(set.status).toBe(200);
    const again = offered(
      await p.w.as(p.w.owner, 'conversation.models', { conversationId: opened['conversationId'] }),
    );
    expect(again.map((model) => model.id)).toContain(HAIKU);
    expect(
      (await p.w.as(p.w.owner, 'conversation.start', { body: 'Hi', model: HAIKU })).status,
    ).toBe(200);
  });

  it('an unlisted person is offered none', async () => {
    const read = offered(await p.w.as(p.w.colleague, 'conversation.models', {}));
    expect(read.map((model) => model.id)).not.toContain(HAIKU);
  });

  it("a conversation on a client's task is offered none, and cannot be moved to it", async () => {
    const { db, business } = p.w.fixture;
    const clientId = randomUUID();
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, p.w.owner, 'share');
    });
    await addClient(db.app, business, clientId, p.w.owner);
    const made = await p.w.as(p.w.owner, 'task.create', { fields: { title: 'A client’s task' } });
    await p.w.as(p.w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: made.body['recordId'],
      expectedRevision: made.body['revision'],
      fields: { client: clientId },
    });
    const scope = { kind: 'task', id: String(made.body['recordId']) };
    const start = await p.w.as(p.w.owner, 'conversation.start', {
      body: 'Hi',
      scope,
      model: HAIKU,
    });
    expect(start.status).toBe(422);
    const opened = detail(await p.w.as(p.w.owner, 'conversation.start', { body: 'Hi', scope }));
    const read = offered(
      await p.w.as(p.w.owner, 'conversation.models', { conversationId: opened['conversationId'] }),
    );
    expect(read.map((model) => model.id)).not.toContain(HAIKU);
    const set = await p.w.as(p.w.owner, 'conversation.set_model', {
      conversationId: opened['conversationId'],
      model: HAIKU,
    });
    expect(set.status).toBe(422);
  });

  it("the panel's words for a paid reply", () => {
    expect(words(budgetWith(24))).toContain('The AI chat budget has AUD 0.24 left');
    expect(words(heldWith(1_025))).toContain('AUD 10.25 stays set aside until an owner records');
    expect(words(refusedWith('STILL_ANSWERING'))).toContain('still on its way');
    expect(words(releasedWith('CUSTODY_NOT_ADMITTED'))).toContain('nothing was sent or charged');
    for (const code of ['BUDGET_UNAVAILABLE', 'PROMPT_TOO_LARGE', 'LOCAL_MODEL_REQUIRED']) {
      expect(words(refusedWith(code))).not.toMatch(/cost nothing|cost zero|must cost/u);
    }
  });
});
