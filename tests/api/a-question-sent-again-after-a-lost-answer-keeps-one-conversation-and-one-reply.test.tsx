// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The drawer's Send again, end to end: the browser's own operations client
// against the server's composition root, its command register and the
// exchange on a migrated database, with the local replay model behind the
// conversation seam. A question's answer is lost on the way back, after the
// server committed it or before the request reached it. Send again resends the
// question under its first operation id, so the register replays a committed
// start or message and the exchange finds its reply kept: one conversation,
// one durable question and one model call for it, whichever way it was lost.

import { randomUUID } from 'node:crypto';
import { act } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { ask, lines, openDrawer, sendAgain } from '../web/assistant-attempt-wire.tsx';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { authorised, BUSINESS_KEY, createApiFixture, tokenFor } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Loss = 'after commit' | 'before commit';

/** Wait, letting React and the database work, until `ready` holds. */
async function until(ready: () => boolean, because: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(because);
    // eslint-disable-next-line no-await-in-loop -- polling the drawer between its own awaits
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    });
  }
}

const answers = (page: Mounted): number =>
  lines(page).filter((line) => line.startsWith('ai: ')).length;

// eslint-disable-next-line max-lines-per-function -- one world, a start and a message each lost both ways
describe.skipIf(serverUrl === undefined)('a question sent again after its answer is lost', () => {
  let w: ConversationWorld;
  let model: LocalModel;
  let token: string;

  beforeAll(async () => {
    model = await localModel();
    const fixture = await createApiFixture('assistant_send_again');
    w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
    token = await tokenFor(w.owner.presented.subject);
  }, 180_000);

  afterAll(async () => {
    await unmountAll();
    await model?.close();
    await w?.drop();
  });

  /** The real client over the composed API; the first `command` sent loses its answer as `loss`. */
  function wire(command: string, loss: Loss) {
    const sent: { readonly name: string; readonly operationId: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const name = String(input).split(`/${BUSINESS_KEY}/`)[1]?.replace('/', '.') ?? '';
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sent.push({ name, operationId: body['operationId'] });
      const lose = name === command && sent.filter((each) => each.name === command).length === 1;
      if (lose && loss === 'before commit') throw new TypeError('The request never arrived.');
      const headers = { ...(init?.headers as Record<string, string>), ...authorised(token) };
      const response = await w.api.fetch(new Request(String(input), { ...init, headers }));
      if (lose) throw new TypeError('The answer was lost after the server kept it.');
      return response;
    };
    const client = new OperationsClient({
      origin: 'http://api.test',
      businessKey: BUSINESS_KEY,
      signedIn: true,
      fetch,
    });
    return {
      client,
      ids: () => sent.filter((each) => each.name === command).map((each) => each.operationId),
    };
  }

  const count = async (sql: string, parameters: readonly unknown[]): Promise<number> =>
    await w.count(sql, parameters);

  /** The conversation the person's `words` are kept in, and how many times they are kept. */
  async function kept(words: string) {
    const rows = await w.fixture.db.admin.execute<{ readonly id: string }>(
      `select conversation_id::text as id from public.conversation_messages
        where role = 'person' and body = $1`,
      [words],
    );
    const conversations = new Set(rows.map((row) => row.id));
    const [conversationId = ''] = conversations;
    const calls = await count(
      'select count(*) as n from public.model_calls where conversation_id = $1',
      [conversationId],
    );
    return { questions: rows.length, conversations: conversations.size, calls };
  }

  async function sentAgain(page: Mounted, replies: number): Promise<void> {
    await until(() => sendAgain(page).length === 1, 'a lost answer offered no Send again');
    await page.click('[data-assistant="send-again"]');
    await until(() => answers(page) === replies, 'Send again drew no reply');
  }

  it.each<Loss>(['after commit', 'before commit'])(
    'a start whose answer is lost %s, sent again, keeps one conversation, its operation id and one reply',
    async (loss) => {
      const words = `Start ${randomUUID()}`;
      const { client, ids } = wire('conversation.start', loss);
      const page = await openDrawer(client, `grant-start-${loss}`);
      await ask(page, words);
      await sentAgain(page, 1);
      expect(await kept(words)).toStrictEqual({ questions: 1, conversations: 1, calls: 1 });
      const [first] = ids();
      expect(ids(), 'Send again sent the start under a new operation id').toStrictEqual([
        first,
        first,
      ]);
      expect(lines(page)).toStrictEqual([`user: ${words}`, 'ai: Drafted.']);
    },
    30_000,
  );

  it.each<Loss>(['after commit', 'before commit'])(
    'a message whose answer is lost %s, sent again, keeps one durable question and one reply attempt',
    async (loss) => {
      const opening = `Open ${randomUUID()}`;
      const words = `Follow up ${randomUUID()}`;
      const { client, ids } = wire('conversation.message', loss);
      const page = await openDrawer(client, `grant-message-${loss}`);
      await ask(page, opening);
      await until(() => answers(page) === 1, 'the opening question drew no reply');
      await ask(page, words);
      await sentAgain(page, 2);
      const asked = await kept(words);
      expect(asked.questions, 'the follow-up was kept twice').toBe(1);
      // The opening question and the follow-up: one model call each.
      expect(asked.calls, 'the follow-up asked the model twice').toBe(2);
      const [first] = ids();
      expect(ids(), 'Send again sent the message under a new operation id').toStrictEqual([
        first,
        first,
      ]);
      expect((await kept(opening)).conversations).toBe(1);
      expect(lines(page)).toStrictEqual([
        `user: ${opening}`,
        'ai: Drafted.',
        `user: ${words}`,
        'ai: Drafted.',
      ]);
    },
    30_000,
  );
});
