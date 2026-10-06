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
});
