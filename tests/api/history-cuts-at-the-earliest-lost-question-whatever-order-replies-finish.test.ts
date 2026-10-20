// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666 against Postgres (`chat-created-fixture.ts`), proof from review
// S1852-1: two queued questions whose replies finish in reverse order, each
// creating a task the asker then loses (read revoked, or a client's). History
// is cut at the earlier question, so its private text reaches no model.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addClient, grantTo } from '../commands/fixture.ts';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import { block, chatWorld, lastSeen, type ChatWorld } from './chat-created-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, each way both tasks are lost
describe.skipIf(serverUrl === undefined)('history cut with replies out of order', () => {
  let c: ChatWorld;
  beforeAll(async () => {
    c = await chatWorld('chat_created_order');
  }, 180_000);
  afterAll(async () => {
    await c?.close();
  });

  it.each(['read revoked', 'client linked'] as const)(
    'history: reverse completion order still cuts history at the earliest lost question (%s)',
    // eslint-disable-next-line max-lines-per-function -- the review's proof, kept whole
    async (loss) => {
      const { who, read } = await c.member('reverse-completion');
      const canary = `PRIVATE-FIRST-QUESTION-${randomUUID()}`;
      c.state.quiet = true;
      const opened = await c.w.as(who, 'conversation.start', { body: `Make a task for ${canary}` });
      const conversationId = String(detail(opened)['conversationId']);
      const firstId = String(detail(opened)['messageId']);
      const second = await c.say(who, conversationId, 'Make another task');
      c.state.quiet = false;
      c.state.says = block('{"action":"create","title":"Second task"}');
      const { db, business } = c.fixture;
      // Two queued questions can finish in this order on independent servers.
      const secondReply = await c.other.exchange(db.app, business, who.presented, {
        conversationId,
        messageId: second.messageId,
      });
      expect(secondReply?.answered).toBe(true);
      if (secondReply?.answered !== true) throw new Error('second reply absent');
      const secondTask = await c.click(who, conversationId, secondReply);
      c.state.says = block(JSON.stringify({ action: 'create', title: canary }));
      const firstReply = await c.model.exchange(db.app, business, who.presented, {
        conversationId,
        messageId: firstId,
      });
      expect(firstReply?.answered).toBe(true);
      if (firstReply?.answered !== true) throw new Error('first reply absent');
      const firstTask = await c.click(who, conversationId, firstReply);
      if (loss === 'read revoked') {
        await db.app.withBusiness(business, async (tx) => {
          await revokeGrant(tx, read);
        });
      } else {
        const client = randomUUID();
        await addClient(db.app, business, client, who);
        await db.app.withBusiness(business, async (tx) => {
          await grantTo(tx, who, 'share');
        });
        /* eslint-disable no-await-in-loop -- one task after another, each at its own revision */
        for (const task of [firstTask, secondTask]) {
          const linked = await c.w.as(who, 'task.set_party', {
            operationId: randomUUID(),
            recordId: task,
            expectedRevision: await c.revisionOf(task),
            fields: { client },
          });
          expect(linked.status).toBe(200);
        }
        /* eslint-enable no-await-in-loop */
      }
      c.state.says = 'Noted.';
      const seen = c.model.provider.seen.length;
      await c.say(who, conversationId, 'Anything else?');
      expect(c.model.provider.seen.length).toBe(seen + 1);
      expect(lastSeen(c.model).body).not.toContain(canary);
    },
  );
});
