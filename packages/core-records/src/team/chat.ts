// SPDX-License-Identifier: AGPL-3.0-only
//
// Team chat: conversations (C71-D) and the groups built on them (C71-G).
// Re-exported whole by the package index (`../index.ts`), which keeps the rest
// of the package's way in.

export {
  CONVERSATION_TYPE_KEY,
  directConversation,
  isStaff,
  listConversations,
  moveReadMarker,
  readConversation,
  readConversationTypes,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationTypes,
} from './conversations.ts';
export {
  allStaff,
  changeGroupMembers,
  GROUP_NAME_LIMIT,
  groupNameOf,
  lockGroup,
  renameGroup,
  startGroup,
  type GroupMembership,
} from './groups.ts';
export { currentConversations, readConversationMentions } from './members.ts';
