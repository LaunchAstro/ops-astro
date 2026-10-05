// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation's last activity moves forward with every message
// (`conversation.message`). The instant it moves to must be the message's
// own, read when it writes, not its transaction's start: a message whose
// transaction began before the message before it, and which is written after
// that one committed, still advances the activity past it, and is listed
// after it.
//
// The third message's transaction begins and holds; the second message goes
// through the API and commits; then the third is sent in the held transaction.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('conversation activity order', () => {
  let w: ConversationWorld;

  beforeAll(async () => {
    w = await conversationWorld('convactivityorder');
  }, 120_000);

  afterAll(async () => await w?.drop());

  const activityOf = async (conversationId: string): Promise<Date> => {
    const rows = await w.fixture.db.admin.execute<{ readonly at: Date }>(
      'select last_activity_at as at from public.conversations where id = $1',
      [conversationId],
    );
    const at = rows[0]?.at;
    if (at === undefined) throw new Error('no conversation');
    return at;
  };

  it('a later message advances activity even when its transaction began before the message before it', async () => {
    const conversationId = await started(w, w.owner, { body: 'first' });
    const early = connect(w.fixture.db.appUrl, { source: 'runtime' });
    try {
      const raced = await early.withBusiness(w.fixture.business, async (tx) => {
        const session = await resolveLogin(tx, w.owner.presented);
        if ('refused' in session) throw new Error(`owner refused ${session.code}`);
        const [began] = await tx.query<{ readonly at: Date }>('select now() as at');
        const second = await w.as(w.owner, 'conversation.message', {
          conversationId,
          body: 'second',
        });
        expect(second.status, JSON.stringify(second.body)).toBe(200);
        const afterSecond = await activityOf(conversationId);
        const third = await runCommand(tx, session, 'api', {
          command: 'conversation.message',
          operationId: randomUUID(),
          conversationId,
          body: 'third, written after the second committed',
        });
        if (isCommandRefusal(third)) throw new Error(`third refused ${third.code}`);
        const [own] = await tx.query<{ readonly at: Date; readonly messages: number }>(
          `select c.last_activity_at as at,
                  (select count(*)::int from public.conversation_messages m
                    where m.business_id = c.business_id and m.conversation_id = c.id) as messages
             from public.conversations c where c.business_id = $1 and c.id = $2`,
          [tx.businessId, conversationId],
        );
        const listed = await tx.query<{ readonly body: string }>(
          `select body from public.conversation_messages
            where business_id = $1 and conversation_id = $2 order by created_at, id`,
          [tx.businessId, conversationId],
        );
        return {
          beganFirst: (began?.at.getTime() ?? Infinity) < afterSecond.getTime(),
          messages: own?.messages,
          advanced: (own?.at.getTime() ?? 0) > afterSecond.getTime(),
          order: listed.map((row) => row.body),
        };
      });
      expect(raced).toEqual({
        beganFirst: true,
        messages: 3,
        advanced: true,
        order: ['first', 'second', 'third, written after the second committed'],
      });
    } finally {
      await early.close();
    }
  }, 30_000);
});
