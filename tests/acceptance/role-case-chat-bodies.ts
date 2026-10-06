// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for team conversations (C71-D): a direct
// message from the admin to the assignee, and the conversation it made, named
// by the read and the read marker.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';

type ChatName = Extract<CommandName, 'chat.send_direct' | 'chat.messages' | 'chat.mark_read'>;

const CHAT_NAMES: ReadonlySet<string> = new Set<ChatName>([
  'chat.send_direct',
  'chat.messages',
  'chat.mark_read',
]);

/** A team conversation write or the message read, each with a recipe here. */
export const isChatName = (name: CommandName): name is ChatName => CHAT_NAMES.has(name);

export async function chatBody(name: ChatName, context: BodyContext): Promise<Prepared> {
  const teammateId = context.assigneePersonId;
  if (name === 'chat.send_direct') return { body: { teammateId, body: 'hello from the matrix' } };
  const sent = await context.asPerson('chat.send_direct', { teammateId, body: `before ${name}` });
  const conversationId = String((sent.body['detail'] as Record<string, unknown>)['conversationId']);
  return name === 'chat.messages'
    ? { body: { conversationId } }
    : { body: { conversationId, upTo: new Date().toISOString() } };
}
