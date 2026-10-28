// SPDX-License-Identifier: AGPL-3.0-only
//
// #1339, the server half of a resend after a lost answer: the web's outbox
// resends an unanswered `chat.send_direct` under its first operation id, and
// the operations register replays the stored answer instead of posting the
// message again. A new id is a new message.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessageView } from '../../packages/core-wire/src/index.ts';
import type { Answer } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';

const detail = (answer: Answer): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a direct message resent under its first operation id',
  () => {
    let chat: ChatWorld;

    beforeAll(async () => {
      chat = await createChatWorld('resend');
    }, 180_000);

    afterAll(async () => {
      await chat?.harness.close();
    });

    const sendAs = async (body: string, operationId: string) => {
      const { ada, mia } = chat.harness.world;
      return await chat.as(ada, 'chat.send_direct', {
        teammateId: mia.personId,
        body,
        operationId,
      });
    };
    const postedWith = async (body: string, conversationId: string) => {
      const { ada } = chat.harness.world;
      const read = await chat.as(ada, 'chat.messages', { conversationId });
      expect(read.status, read.text).toBe(200);
      const messages = read.body['messages'] as ChatMessageView[];
      return messages.filter((message) => message.body === body).length;
    };

    it('posts the message once, and answers the resend with the first send’s message', async () => {
      const words = `resend canary ${randomUUID()}`;
      const operationId = randomUUID();
      const first = await sendAs(words, operationId);
      expect(first.status, first.text).toBe(200);
      const again = await sendAs(words, operationId);
      expect(again.status, again.text).toBe(200);
      expect(detail(again)['commentId']).toBe(detail(first)['commentId']);
      expect(await postedWith(words, String(detail(first)['conversationId']))).toBe(1);
    });

    it('the same words under a new operation id are a second message', async () => {
      const words = `second canary ${randomUUID()}`;
      const first = await sendAs(words, randomUUID());
      const second = await sendAs(words, randomUUID());
      expect(second.status, second.text).toBe(200);
      const conversationId = String(
        (first.body['detail'] as Record<string, unknown>)['conversationId'],
      );
      expect(await postedWith(words, conversationId)).toBe(2);
    });
  },
);
