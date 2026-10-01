// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for team conversations: a direct message from
// the admin to the assignee, and the conversation it made, named by the read
// and the read marker (C71-D); a group the admin starts with two new members,
// written to, renamed, its members changed and left (C71-G).

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';

export type ChatName = Extract<
  CommandName,
  | 'chat.send_direct'
  | 'chat.messages'
  | 'chat.mark_read'
  | 'chat.start_group'
  | 'chat.send_group'
  | 'chat.rename_group'
  | 'chat.change_members'
  | 'chat.leave'
>;

const CHAT_NAMES: ReadonlySet<string> = new Set<ChatName>([
  'chat.send_direct',
  'chat.messages',
  'chat.mark_read',
  'chat.start_group',
  'chat.send_group',
  'chat.rename_group',
  'chat.change_members',
  'chat.leave',
]);

/** A team conversation write or the message read, each with a recipe here. */
export const isChatName = (name: CommandName): name is ChatName => CHAT_NAMES.has(name);

const conversationOf = (body: Readonly<Record<string, unknown>>): string =>
  String((body['detail'] as Record<string, unknown> | undefined)?.['conversationId']);

/** A group the admin starts with two new members of the business. */
async function groupBody(name: ChatName, context: BodyContext): Promise<Prepared> {
  const { freshMember } = context;
  if (freshMember === undefined) return { exception: 'no member maker here' };
  const members = [await freshMember(), await freshMember()];
  if (name === 'chat.start_group') return { body: { name: 'The matrix crew', members } };
  const started = await context.asPerson('chat.start_group', { name: `before ${name}`, members });
  const conversationId = conversationOf(started.body);
  if (name === 'chat.send_group') return { body: { conversationId, body: 'hello, crew' } };
  if (name === 'chat.rename_group') return { body: { conversationId, name: 'Renamed crew' } };
  if (name === 'chat.change_members') {
    return { body: { conversationId, add: [await freshMember()], remove: [members[0]] } };
  }
  return { body: { conversationId } };
}

export async function chatBody(name: ChatName, context: BodyContext): Promise<Prepared> {
  if (name !== 'chat.send_direct' && name !== 'chat.messages' && name !== 'chat.mark_read') {
    return await groupBody(name, context);
  }
  const teammateId = context.assigneePersonId;
  if (name === 'chat.send_direct') return { body: { teammateId, body: 'hello from the matrix' } };
  const sent = await context.asPerson('chat.send_direct', { teammateId, body: `before ${name}` });
  const conversationId = conversationOf(sent.body);
  return name === 'chat.messages'
    ? { body: { conversationId } }
    : { body: { conversationId, upTo: new Date().toISOString() } };
}
