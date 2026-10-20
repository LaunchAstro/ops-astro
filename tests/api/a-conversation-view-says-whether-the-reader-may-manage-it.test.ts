// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-G, CS-7.41: `chat.conversations` tells each reader whether they may
// rename a group and change its members, by the rule `chat.rename_group` and
// `chat.change_members` hold them to: the creator while a member, or a member
// holding `chat:manage` (the owner and administrators). Anyone else in it may
// not, and no one manages a direct conversation. The cast is
// `c71-g-world.ts`'s: Tess started the group with Ada, an administrator
// holding `chat:manage`, and Mia, who holds `chat:comment` alone. An agent
// credential stands on its person's grants only within the keys it ticked,
// so Ada's credential without `chat:manage` may not manage the group.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readChatConversations } from '../../packages/core-commands/src/reads/chat.ts';
import { NO_ASSURANCE } from '../../packages/core-records/src/index.ts';
import type { ChatConversationView } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { idOf } from './c71-d-lock-world.ts';
import { createGroupWorld, type GroupWorld, type Who } from './c71-g-world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'C71-G whether a reader may manage a conversation',
  // eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
  () => {
    let g: GroupWorld;

    beforeAll(async () => {
      g = await createGroupWorld('managesview');
    }, 180_000);

    afterAll(async () => {
      await g?.chat.harness.close();
    });

    const manages = async (who: Who, id?: string): Promise<boolean | undefined> =>
      ((await g.viewOf(who, id)) as (ChatConversationView & { canManage?: boolean }) | undefined)
        ?.canManage;

    it('the creator and a member holding chat:manage may manage the group, another member may not, and no one manages a direct conversation', async () => {
      const { chat } = g;
      const { world } = chat.harness;
      const direct = await chat.send(chat.tess, world.mia, 'a direct word');
      expect(direct.status, direct.text).toBe(200);
      const directId = idOf(direct);

      const seen = {
        group: {
          creator: await manages(chat.tess),
          manager: await manages(world.ada),
          member: await manages(world.mia),
        },
        direct: {
          sender: await manages(chat.tess, directId),
          recipient: await manages(world.mia, directId),
        },
      };

      expect(seen).toStrictEqual({
        group: { creator: true, manager: true, member: false },
        direct: { sender: false, recipient: false },
      });
    });

    it('the creator who has left the group no longer may manage it', async () => {
      const { chat, as, conversationId } = g;
      const left = await as(chat.tess, 'chat.leave', { conversationId });
      expect(left.status, left.text).toBe(200);
      expect(await manages(chat.tess)).toBe(false);
      expect(await manages(chat.harness.world.ada)).toBe(true);
    });

    it('a session standing on a credential may manage the group only when its ticked keys include chat:manage', async () => {
      const { world } = g.chat.harness;
      const ada = world.ada;
      // The agent route refuses `chat.conversations` today, so the read is
      // asked directly, as Ada and as credential sessions standing on her grants.
      const asSession = async (credentialScope?: readonly string[]) =>
        await world.db.app.withBusiness(world.alpha, async (tx) => {
          const read = await readChatConversations(tx, {
            businessId: world.alpha,
            loginId: randomUUID(),
            personId: String(ada.personId),
            actorId: String(ada.actorId),
            roleKey: 'admin',
            assurance: NO_ASSURANCE,
            ...(credentialScope === undefined ? {} : { credentialScope }),
          });
          if (!('conversations' in read)) throw new Error(`refused: ${read.code}`);
          return read.conversations.find((one) => one.conversationId === g.conversationId)
            ?.canManage;
        });
      const seen = {
        person: await asSession(),
        commentOnly: await asSession(['chat:comment']),
        withManage: await asSession(['chat:comment', 'chat:manage']),
      };
      expect(seen).toStrictEqual({ person: true, commentOnly: false, withManage: true });
    });
  },
);
