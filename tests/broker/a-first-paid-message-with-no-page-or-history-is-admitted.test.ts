// SPDX-License-Identifier: AGPL-3.0-only
//
// The carve-out takes the message alone, or with the page, or with the
// earlier turns, and nothing else: a fresh conversation's first message (no
// page, no history) holds and sends once, as does one with a page and no
// history, and a later message with history and no page. A call with no
// message is refused before any row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, scopeOf, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// oxlint-disable-next-line max-lines-per-function -- one world, a case per shape of fields
describe.skipIf(serverUrl === undefined)('a first paid message', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_first_message');
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  const fieldsSent = (): readonly string[] =>
    Object.keys((p.openrouter.received.at(-1)?.body['fields'] ?? {}) as object).toSorted();

  it('no page and no history: held and sent once, with the message alone', async () => {
    const asked = await p.question('What is due today?');
    const sent = p.openrouter.received.length;
    expect(await p.ask(asked)).toMatchObject({ answered: true });
    expect(p.openrouter.received.length).toBe(sent + 1);
    expect(fieldsSent()).toStrictEqual(['message']);
  });

  it('a page and no history: the page and the message', async () => {
    const made = await p.w.as(p.w.owner, 'task.create', { fields: { title: 'Roster for May' } });
    const asked = await p.question('What is left on this?', undefined, {
      scope: { kind: 'task', id: String(made.body['recordId']) },
    });
    expect(await p.ask(asked)).toMatchObject({ answered: true });
    expect(fieldsSent()).toStrictEqual(['message', 'page']);
  });

  it('history and no page: the earlier turns and the message', async () => {
    const first = await p.question('What is due today?');
    await p.ask(first);
    const asked = await p.next(first.conversationId, 'And tomorrow?');
    expect(await p.ask(asked)).toMatchObject({ answered: true });
    expect(fieldsSent()).toStrictEqual(['earlier', 'message']);
  });

  it('no message: refused before any row', async () => {
    const asked = await p.question('What is due today?');
    const sent = p.openrouter.received.length;
    const scope = scopeOf(p, asked);
    const noMessage = {
      ...scope,
      fields: [{ name: 'page', source: 'outside' as const, value: '{}' }],
    };
    expect(await p.direct(noMessage)).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(await p.calls(asked.conversationId)).toHaveLength(0);
    expect(p.openrouter.received.length).toBe(sent);
  });
});
