// SPDX-License-Identifier: AGPL-3.0-only
//
// Team chat's writes (C71-D direct, C71-G groups), spread into `HANDLERS` in
// `handlers.ts` (moved whole for the line cap). The mapped type answers here as
// it does there: a chat write added to the request union with no entry is a
// type error.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import type { HandlerOutcome } from './outcome.ts';
import { markOwnRead, sendDirect } from './chat.ts';
import {
  changeGroupConversationMembers,
  leaveGroupConversation,
  renameGroupConversation,
  sendGroupMessage,
  startGroupConversation,
} from './chat-groups.ts';

type ChatName = Extract<CommandRequest['command'], `chat.${string}`>;
type RequestOf<K extends ChatName> = CommandRequest & { readonly command: K };

export const CHAT_HANDLERS: {
  readonly [K in ChatName]: (
    tx: TenantQuery,
    context: CommandContext,
    request: RequestOf<K>,
  ) => Promise<HandlerOutcome>;
} = {
  // C71-D: the sender and reader are the session's; a body names only the teammate or conversation.
  'chat.send_direct': (tx, context, chat) => sendDirect(tx, context, chat.teammateId, chat.body),
  'chat.mark_read': (tx, context, chat) => markOwnRead(tx, context, chat.conversationId, chat.upTo),
  // C71-G. The creator, the sender and the leaver are the session's.
  'chat.start_group': (tx, context, request) =>
    startGroupConversation(tx, context, request.name, request.members),
  'chat.send_group': (tx, context, request) =>
    sendGroupMessage(tx, context, request.conversationId, request.body),
  'chat.rename_group': (tx, context, request) =>
    renameGroupConversation(tx, context, request.conversationId, request.name),
  'chat.change_members': (tx, context, request) =>
    changeGroupConversationMembers(tx, context, request.conversationId, request),
  'chat.leave': (tx, context, request) =>
    leaveGroupConversation(tx, context, request.conversationId),
};
