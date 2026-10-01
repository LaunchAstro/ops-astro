// SPDX-License-Identifier: AGPL-3.0-only
//
// The world C71-G's suites share: C71-D's chat world (`c71-d-world.ts`) and
// Zed, alpha staff holding `chat:comment`, who is in no group at first. Tess,
// holding `chat:comment` alone, starts the group with Ada (an administrator,
// holding `chat:manage`) and Mia, and writes its first message, the canary.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { ChatConversationView, ChatMessageView } from '../../packages/core-wire/src/index.ts';
import { enrolCaller, type Caller } from '../acceptance/cast.ts';
import type { Answer } from '../acceptance/world.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';

export type Body = Readonly<Record<string, unknown>>;
export type Who = Parameters<ChatWorld['as']>[0];

// Red: the group commands are not on the surface yet, so their names are text here.
type Loose = (who: Who, name: string, body?: Body, business?: string) => Promise<Answer>;
type LooseAgent = (name: string, body: Body, credential?: string) => Promise<Answer>;

export interface GroupWorld {
  readonly chat: ChatWorld;
  readonly zed: Caller;
  readonly canary: string;
  readonly groupName: string;
  /** The group Tess started. */
  readonly conversationId: string;
  as: Loose;
  asAgent: LooseAgent;
  start(by: Who, members: readonly unknown[], name?: string): Promise<Answer>;
  say(who: Who, body: string, id?: string): Promise<Answer>;
  /** The caller's view of a conversation, or undefined where it is not listed. */
  viewOf(who: Who, id?: string): Promise<ChatConversationView | undefined>;
  /** The message bodies the caller reads, oldest first; none where refused. */
  bodiesOf(who: Who, id?: string): Promise<readonly string[]>;
  /** A command's audit events, every actor's or one's, in order. */
  auditOf(
    command: string,
    actorId?: string | null,
  ): Promise<readonly { readonly outcome: string; readonly t: string }[]>;
}

export const detailOf = (answer: Answer): Body => (answer.body['detail'] as Body | undefined) ?? {};

export async function createGroupWorld(part: string): Promise<GroupWorld> {
  const chat = await createChatWorld(part);
  const { world } = chat.harness;
  const zed = await enrolCaller(world.db, world.alpha, 'alpha', 'zed', {
    membership: true,
    actions: ['comment'],
    collections: ['chat'],
  });
  const as: Loose = async (...args) => await (chat.as as Loose)(...args);
  const asAgent: LooseAgent = async (...args) =>
    await (chat.harness.asAgent as LooseAgent)(...args);
  const canary = `group-canary-${randomUUID()}`;
  const groupName = `Launch crew ${randomUUID().slice(0, 8)}`;
  const start: GroupWorld['start'] = async (by, members, name = groupName) =>
    await as(by, 'chat.start_group', { name, members });
  const started = await start(chat.tess, [world.ada.personId, world.mia.personId]);
  expect(started.status, started.text).toBe(200);
  const conversationId = String(detailOf(started)['conversationId']);
  const say: GroupWorld['say'] = async (who, body, id = conversationId) =>
    await as(who, 'chat.send_group', { conversationId: id, body });
  expect((await say(chat.tess, canary)).status).toBe(200);
  return {
    chat,
    zed,
    canary,
    groupName,
    conversationId,
    as,
    asAgent,
    start,
    say,
    viewOf: async (who, id = conversationId) =>
      ((await as(who, 'chat.conversations')).body['conversations'] as ChatConversationView[]).find(
        (one) => one.conversationId === id,
      ),
    bodiesOf: async (who, id = conversationId) =>
      (
        ((await as(who, 'chat.messages', { conversationId: id })).body['messages'] ??
          []) as ChatMessageView[]
      ).map((m) => m.body),
    auditOf: async (command, actorId) =>
      await world.db.admin.execute<{ readonly outcome: string; readonly t: string }>(
        `select outcome, e::text as t from public.audit_events e
          where command = $1 and ($2::uuid is null or actor_id = $2::uuid) order by seq`,
        [command, actorId ?? null],
      ),
  };
}
