// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { contextOf } from '../../packages/core-commands/src/commands/conversation-context.ts';
import { withSession } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import { epochWorld, ownerOn, stepped } from './conversation-epoch-fixture.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'ownership cannot change between the check and the earlier-message read',
  async () => {
    const c = await epochWorld('sol1783_owner_race');
    const reader = stepped(c.fixture.db.appUrl, 'select role, body, author from (', 'hold-before');
    let reading: ReturnType<typeof withSession> | undefined;
    try {
      const canary = `private-owner-question-${randomUUID()}`;
      const opened = await c.w.as(c.w.owner, 'conversation.start', { body: canary });
      expect(opened.body['reply']).toMatchObject({ answered: true });
      const conversationId = String(detail(opened)['conversationId']);
      const body = 'pending question';
      const pending = await ownerOn(c, c.unanswered, 'conversation.message', {
        operationId: randomUUID(),
        conversationId,
        body,
      });
      const messageId = String(detail(pending)['messageId']);
      const result = withSession(
        reader.database,
        c.fixture.business,
        c.w.owner.presented,
        (tx, session) => contextOf(tx, session, { conversationId, messageId, body }, null),
      );
      reading = result;
      await reader.reached;
      let changed = false;
      try {
        await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
          await tx.query('select id from conversations where id = $1 for update nowait', [
            conversationId,
          ]);
          await tx.query(
            'update conversations set owner_actor_id = $1, owner_person_id = $2 where id = $3',
            [c.w.colleague.actorId, c.w.colleague.personId, conversationId],
          );
        });
        changed = true;
      } catch (error) {
        if ((error as { code?: string }).code !== '55P03') throw error;
      }
      reader.release();
      const context = await result;
      // A writer either waits for the protected read, or a read after a committed
      // ownership change must refuse the former owner before returning any words.
      if (changed) expect(JSON.stringify(context)).not.toContain(canary);
      else expect(JSON.stringify(context)).toContain(canary);
    } finally {
      reader.release();
      await reading?.catch(() => undefined);
      await reader.close();
      await c.drop();
    }
  },
  180_000,
);

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a committed ownership change refuses the former owner',
  async () => {
    const c = await epochWorld('sol1783_owner_race');
    const reader = stepped(c.fixture.db.appUrl, 'select role, body, author from (', 'hold-before');
    let reading: ReturnType<typeof withSession> | undefined;
    try {
      const canary = `private-owner-question-${randomUUID()}`;
      const opened = await c.w.as(c.w.owner, 'conversation.start', { body: canary });
      expect(opened.body['reply']).toMatchObject({ answered: true });
      const conversationId = String(detail(opened)['conversationId']);
      const body = 'pending question';
      const pending = await ownerOn(c, c.unanswered, 'conversation.message', {
        operationId: randomUUID(),
        conversationId,
        body,
      });
      const messageId = String(detail(pending)['messageId']);
      const result = withSession(
        reader.database,
        c.fixture.business,
        c.w.owner.presented,
        (tx, session) => contextOf(tx, session, { conversationId, messageId, body }, null),
      );
      reading = result;
      await reader.reached;
      let changed = false;
      try {
        await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
          await tx.query('select id from conversations where id = $1 for update nowait', [
            conversationId,
          ]);
          await tx.query(
            'update conversations set owner_actor_id = $1, owner_person_id = $2 where id = $3',
            [c.w.colleague.actorId, c.w.colleague.personId, conversationId],
          );
        });
        changed = true;
      } catch (error) {
        if ((error as { code?: string }).code !== '55P03') throw error;
      }
      reader.release();
      const context = await result;
      // A writer either waits for the protected read, or a read after a committed
      // ownership change must refuse the former owner before returning any words.
      if (changed) expect(context).toEqual({ refused: true, fields: [], cites: [], authors: [] });
      else expect(JSON.stringify(context)).toContain(canary);
    } finally {
      reader.release();
      await reading?.catch(() => undefined);
      await reader.close();
      await c.drop();
    }
  },
  180_000,
);
