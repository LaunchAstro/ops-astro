// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation whose page task has a client never reaches OpenRouter: a
// client linked to the page after the paid model was picked is refused at the
// exchange, with no row and no request: the paid model is no longer offered
// on a client's page, so the exchange refuses it before the context is asked.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a client-linked conversation', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_client_context');
    await p.w.fixture.db.app.withBusiness(p.w.fixture.business, async (tx) => {
      await grantTo(tx, p.w.owner, 'share');
    });
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('a client linked to the page after the pick: refused, no row, no request', async () => {
    const { db, business } = p.w.fixture;
    const made = await p.w.as(p.w.owner, 'task.create', { fields: { title: 'Roster for May' } });
    const asked = await p.question('What is left?', undefined, {
      scope: { kind: 'task', id: String(made.body['recordId']) },
    });
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, p.w.owner);
    const placed = await p.w.as(p.w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: made.body['recordId'],
      expectedRevision: made.body['revision'],
      fields: { client: clientId },
    });
    expect(placed.status).toBe(200);
    expect(await p.ask(asked)).toMatchObject({ answered: false, code: 'MODEL_NOT_OFFERED' });
    expect(await p.calls(asked.conversationId)).toHaveLength(0);
    expect(p.openrouter.received).toHaveLength(0);
  });
});
