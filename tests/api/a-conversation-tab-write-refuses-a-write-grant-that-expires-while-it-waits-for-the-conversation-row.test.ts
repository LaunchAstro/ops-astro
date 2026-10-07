// SPDX-License-Identifier: AGPL-3.0-only
//
// The tab row's writes (`conversation.set_model`, `conversation.rename`,
// `conversation.set_scope`) are admitted on the owner's `conversation:write`
// grant, then wait for the conversation's row lock before they write
// (`conversation-tabs.ts` `ownedForUpdate`). A grant that expires during that
// wait no longer counts: each write is refused and nothing changes, as
// `conversation.message` is refused across the same wait.
//
// One write at a time: the conversation row is held on another connection,
// which holds no grant; the write is seen waiting on that holder with its
// transaction begun before the grant's expiry; the holder lets go once the
// database clock is past it. Each write sets the grant to end afresh.

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
import type { Member } from '../commands/fixture.ts';
import type { Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WRITES = [
  ['conversation.set_model', { model: REPLAY_MODEL_WINDOW.model }],
  ['conversation.rename', { title: 'Renamed across the expiry' }],
  ['conversation.set_scope', { page: { address: '/tasks', shows: 'the task list' } }],
] as const;

const KEPT = 'select model_id, title, page_address from public.conversations where id = $1';

/**
 * Sets `person`'s only covering conversation:write grant to end in three
 * seconds, holds the conversation row, sends `write` on it, sees it waiting on the
 * holder from before the expiry, and lets go once the database clock is past it.
 */
async function acrossTheExpiry(
  w: ConversationWorld,
  person: Member,
  id: string,
  [name, fields]: (typeof WRITES)[number],
): Promise<{ readonly startedLive: boolean; readonly answer: Answer }> {
  const db = w.fixture.db;
  const { expiry } = await expiringSoon(w, person.personId, 'conversation', 'write');
  const held = await holdRow(db, 'select id from public.conversations where id = $1 for update', [
    id,
  ]);
  const sending = w.as(person, name, { conversationId: id, ...fields });
  let startedLive = false;
  try {
    startedLive = await blockedBefore(db, held, expiry);
    await waitPast(db, expiry);
  } finally {
    await held.letGo();
  }
  return { startedLive, answer: await sending };
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
      const seen: unknown[] = [];
      for (const [at, write] of WRITES.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one expiry at a time
        const { startedLive, answer } = await acrossTheExpiry(w, person, ids[at] ?? '', write);
        seen.push({
          name: write[0],
          startedLive,
          status: answer.status,
          code: answer.body['code'],
        });
      }
      expect({ seen, kept: await kept() }).toEqual({
        seen: WRITES.map(([name]) => ({
          name,
          startedLive: true,
          status: 403,
          code: 'SCOPE_NOT_GRANTED',
        })),
        kept: before,
      });
    }, 60_000);
  },
);
