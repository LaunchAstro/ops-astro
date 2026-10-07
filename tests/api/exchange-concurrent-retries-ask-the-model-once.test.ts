// SPDX-License-Identifier: AGPL-3.0-only
//
// Two requests for the answer to one message, the second while the first is
// still with the model: the model is asked once, and both requests get the
// first's outcome. Without that, each retry would dispatch its own call and
// spend its own tokens on the laptop's plan, though only one reply is kept.
// The stand-in holds its answer past the call's timeout, so the first call is
// in flight for the whole of the second request.

import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, both races on it
describe.skipIf(serverUrl === undefined)('a retry while the answer is with the model', () => {
  let w: ConversationWorld;
  let model: LocalModel;
  beforeAll(async () => {
    w = await conversationWorld('exchange_retry_once');
    model = await localModel();
  }, 180_000);
  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  it('asks the model once, and both requests get the same outcome', async () => {
    const opened = await w.as(w.colleague, 'conversation.start', { body: 'Once, please' });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    model.provider.mode('slow');
    const ask = async () =>
      await model.exchange(w.fixture.db.app, w.fixture.business, w.colleague.presented, asked);
    const first = ask();
    while (model.provider.seen.length === 0) {
      // eslint-disable-next-line no-await-in-loop -- until the first call reaches the model
      await nextTurn();
    }
    const second = ask();
    const outcomes = await Promise.all([first, second]);
    expect(model.provider.seen).toHaveLength(1);
    expect(outcomes[1]).toEqual(outcomes[0]);
  }, 30_000);

  it('a retry whose read finished before the first answer was kept, but returns after, asks nothing', async () => {
    model.provider.mode('answer');
    const opened = await w.as(w.colleague, 'conversation.start', { body: 'Late, please' });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    const { app } = w.fixture.db;
    // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced below
    let read: () => void = () => {};
    const readDone = new Promise<void>((resolve) => {
      read = resolve;
    });
    // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced below
    let deliver: () => void = () => {};
    const delivered = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    // The retry's first transaction (its read) commits, and its result comes back only later.
    let first = true;
    const late: typeof app = Object.create(app) as typeof app;
    Object.assign(late, {
      withBusiness: async (...call: Parameters<typeof app.withBusiness>) => {
        const result = await app.withBusiness(...call);
        if (first) {
          first = false;
          read();
          await delivered;
        }
        return result;
      },
    });
    const before = model.provider.seen.length;
    const retry = model.exchange(late, w.fixture.business, w.colleague.presented, asked);
    await readDone;
    const answer = await model.exchange(app, w.fixture.business, w.colleague.presented, asked);
    expect(answer).toMatchObject({ answered: true });
    deliver();
    expect(await retry).toEqual(answer);
    expect(model.provider.seen.length).toBe(before + 1);
  }, 30_000);
});
