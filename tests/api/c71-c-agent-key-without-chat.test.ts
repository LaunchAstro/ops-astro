// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent key (API-2) stands on its person's grants only within the keys it
// ticks: one that does not tick `chat:comment` is shown no conversation's
// mention in `inbox.read` and counts none in `inbox.count`, as `chat.messages`
// refuses it. The key is put on Mia's own session, as the credential door does.

import { expect, it } from 'vitest';
import { withSession, type Session } from '../../packages/core-records/src/index.ts';
import { runRead } from '../../packages/core-commands/src/reads/dispatch.ts';
import type { InboxEntry } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createGroupWorld } from './c71-g-world.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'an agent key that does not tick chat:comment is shown and counted no conversation mention',
  async () => {
    const g = await createGroupWorld('agentkeychat');
    const { world } = g.chat.harness;
    try {
      const mentioned = await g.as(g.chat.tess, 'chat.send_group', {
        conversationId: g.conversationId,
        body: 'Mia, a look?',
        mentions: [world.mia.personId],
      });
      expect(mentioned.status, mentioned.text).toBe(200);
      const asKey = async (ticked: readonly string[]) => {
        const seen = await withSession(
          world.db.app,
          world.alpha,
          world.mia.presented,
          async (tx, session) => {
            const key: Session = { ...session, credentialScope: ticked };
            const read = await runRead(tx, key, { read: 'inbox.read' });
            const count = await runRead(tx, key, { read: 'inbox.count' });
            const inbox = (read as { readonly inbox?: readonly InboxEntry[] }).inbox ?? [];
            return {
              conversations: inbox.filter((entry) => entry.conversation !== undefined).length,
              owed: (count as { readonly owed?: number }).owed,
            };
          },
        );
        if (!('conversations' in seen)) throw new Error(JSON.stringify(seen));
        return seen;
      };
      const chatting = await asKey(['task:read', 'chat:comment']);
      expect(chatting.conversations, 'a key ticking chat:comment').toBe(1);
      const tasksOnly = await asKey(['task:read']);
      expect(tasksOnly).toEqual({ conversations: 0, owed: Number(chatting.owed) - 1 });
    } finally {
      await g.chat.harness.close();
    }
  },
  180_000,
);
