// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { catalogue, EMAIL_SEND, emailAdapter } from '../../packages/core-connectors/src/index.ts';
import { sendInboxEmail, type Broker } from '../../packages/core-custody/src/index.ts';
import type { InboxEntry } from '../../packages/core-wire/src/index.ts';
import { createGroupWorld } from './c71-g-world.ts';
import { MAIL } from '../broker/email-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

function mailProbe(): { broker: Broker; dispatched: string[] } {
  const dispatched: string[] = [];
  return {
    dispatched,
    broker: {
      custody: {
        pid: 0,
        dispatch: (ref) => {
          dispatched.push(ref);
          return Promise.resolve({ kind: 'refused', started: false, code: 'NOT_SENT_IN_TEST' });
        },
        stderr: () => '',
        describe: () => Promise.resolve(null),
        raw: () => Promise.resolve({}),
        kill: () => {},
        stop: () => Promise.resolve(),
      },
      operations: catalogue([EMAIL_SEND]),
      providers: new Map([['resend', { build: emailAdapter, price: () => 0 }]]),
      routes: [
        {
          key: 'email',
          reach: 'cloud',
          provider: 'resend',
          credentialRef: 'test_key',
          credentialKind: 'api_key',
          installation: 'here',
          ceiling: 4,
        },
      ],
      installation: 'here',
      audit: () => Promise.resolve(),
    },
  };
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'revoking or ending chat access withholds conversation mentions, new names and email delivery',
  // eslint-disable-next-line max-lines-per-function -- one revocation read through each affected gate
  async () => {
    const g = await createGroupWorld('sol357revoke');
    const { world } = g.chat.harness;
    try {
      const sent = await g.as(g.chat.tess, 'chat.send_group', {
        conversationId: g.conversationId,
        body: '@Mia before revocation',
        mentions: [world.mia.personId],
      });
      expect(sent.status, sent.text).toBe(200);
      const before = await g.as(world.mia, 'inbox.read');
      const items = before.body['inbox'] as readonly InboxEntry[];
      const item = items.find((entry) => entry.subjectRecordId === g.conversationId);
      expect(item?.counted).toBe(true);
      const grants = await world.db.admin.execute<{ id: string }>(
        `select id from public.grants where business_id = $1 and subject_id = $2
        and collection = 'chat' and action = 'comment' and revoked_at is null`,
        [world.alpha, world.mia.personId],
      );
      expect(grants).toHaveLength(1);
      const revoked = await g.as(world.ada, 'access.revoke', { grantId: grants[0]?.id });
      expect(revoked.status, revoked.text).toBe(200);
      const messages = await g.as(world.mia, 'chat.messages', { conversationId: g.conversationId });
      expect(messages.code).toBe('SCOPE_NOT_GRANTED');
      const newName = 'Confidential name created after Mia lost chat access';
      const renamed = await g.as(g.chat.tess, 'chat.rename_group', {
        conversationId: g.conversationId,
        name: newName,
      });
      expect(renamed.status, renamed.text).toBe(200);
      const inbox = await g.as(world.mia, 'inbox.read');
      expect.soft(inbox.text).not.toContain(newName);
      expect
        .soft(inbox.body['inbox'] as readonly InboxEntry[])
        .not.toEqual(
          expect.arrayContaining([expect.objectContaining({ subjectRecordId: g.conversationId })]),
        );
      expect.soft((await g.as(world.mia, 'inbox.count')).body['owed']).toBe(0);
      const seen = await g.as(world.mia, 'inbox.seen', { itemId: item?.id });
      expect.soft(seen.code).toBe('NOT_FOUND');
      const after = await g.as(g.chat.tess, 'chat.send_group', {
        conversationId: g.conversationId,
        body: '@Mia after revocation',
        mentions: [world.mia.personId],
      });
      expect.soft(after.code, after.text).toBe('MENTION_NOT_READABLE');
      const ended = await g.as(world.ada, 'access.end', { holderId: world.mia.personId });
      expect(ended.status, ended.text).toBe(200);
      expect(
        (await g.as(world.mia, 'chat.messages', { conversationId: g.conversationId })).code,
      ).toBe('AUTH_NO_MEMBERSHIP');
      await world.db.admin.execute(
        `insert into public.person_identifiers
         (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
       values ($1, gen_random_uuid(), $2, 'email', $3, $3, 'test', 'confirmed')`,
        [world.alpha, world.mia.personId, 'synthetic-ended-mia@example.test'],
      );
      if (item === undefined) throw new Error('mention item missing');
      const { broker, dispatched } = mailProbe();
      const email = await sendInboxEmail(world.db.app, world.alpha, item.id, broker, MAIL);
      expect.soft(email).toEqual({ ok: false, code: 'ITEM_WITHHELD' });
      expect.soft(dispatched).toEqual([]);
    } finally {
      await g.chat.harness.close();
    }
  },
  180_000,
);
