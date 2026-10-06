// SPDX-License-Identifier: AGPL-3.0-only
//
// The tab row's writes (`conversation.set_model`, `conversation.rename`,
// `conversation.set_scope`) are admitted on the owner's `conversation:write`
// grant, then wait for the conversation's row lock before they write
// (`conversation-tabs.ts` `ownedForUpdate`). A grant that expires during that
// wait no longer counts: each write is refused and nothing changes, as
// `conversation.message` is refused across the same wait.
//
// Each conversation row is held on another connection, which holds no grant;
// each write is seen waiting on its holder with its transaction begun before
// the grant's expiry; the holders let go once the database clock is past it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPLAY_MODEL_WINDOW } from '../../packages/core-connectors/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { blockedBefore, holdRow, waitPast } from '../support/lock-wait-race.ts';
import {
  conversationWorld,
  expiringSoon,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import type { Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WRITES = [
  ['conversation.set_model', { model: REPLAY_MODEL_WINDOW.model }],
  ['conversation.rename', { title: 'Renamed across the expiry' }],
  ['conversation.set_scope', { page: { address: '/tasks', shows: 'the task list' } }],
] as const;

const KEPT = 'select model_id, title, page_address from public.conversations where id = $1';

/**
 * Holds each conversation row, sends `send` for each, sees each waiting on its
 * holder from before `expiry`, and lets go once the database clock is past it.
 */
async function acrossTheExpiry(
  w: ConversationWorld,
  ids: readonly string[],
  expiry: string,
  send: (id: string, at: number) => Promise<Answer>,
): Promise<{ readonly startedLive: boolean[]; readonly answers: Answer[] }> {
  const db = w.fixture.db;
  const holders = await Promise.all(
    ids.map(
      async (id) =>
        await holdRow(db, 'select id from public.conversations where id = $1 for update', [id]),
    ),
  );
  const sending = ids.map(async (id, at) => await send(id, at));
  let startedLive: boolean[] = [];
  try {
    startedLive = await Promise.all(
      holders.map(async (held) => await blockedBefore(db, held, expiry)),
    );
    await waitPast(db, expiry);
  } finally {
    await Promise.all(holders.map(async (held) => await held.letGo()));
  }
  return { startedLive, answers: await Promise.all(sending) };
}

describe.skipIf(serverUrl === undefined)(
  'a conversation grant expiring while a tab write waits',
  () => {
    let w: ConversationWorld;
    beforeAll(async () => {
      w = await conversationWorld('tab_write_grant_expiry');
    }, 180_000);
    afterAll(async () => {
      await w?.drop();
    });

    it('a model choice, a rename and a page pointer each refuse a write grant that expires while they wait for the conversation row', async () => {
      const person = w.colleague;
      const db = w.fixture.db;
      const ids: string[] = [];
      for (const [name] of WRITES) {
        // oxlint-disable-next-line no-await-in-loop -- one conversation per write, in order
        ids.push(await started(w, person, { body: `Before the expiry, for ${name}` }));
      }
      const kept = async (): Promise<unknown[]> =>
        await Promise.all(ids.map(async (id) => (await db.admin.execute(KEPT, [id]))[0]));
      const before = await kept();
      // The colleague's only covering conversation:write grant, ending in three seconds.
      const { expiry } = await expiringSoon(w, person.personId, 'conversation', 'write');
      const { startedLive, answers } = await acrossTheExpiry(w, ids, expiry, async (id, at) => {
        const [name, fields] = WRITES[at] ?? WRITES[0];
        return await w.as(person, name, { conversationId: id, ...fields });
      });
      expect({
        startedLive,
        answers: answers.map((answer) => [answer.status, answer.body['code']]),
        kept: await kept(),
      }).toEqual({
        startedLive: [true, true, true],
        answers: WRITES.map(() => [403, 'SCOPE_NOT_GRANTED']),
        kept: before,
      });
    }, 30_000);
  },
);
