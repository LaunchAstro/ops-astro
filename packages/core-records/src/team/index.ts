// SPDX-License-Identifier: AGPL-3.0-only
//
// Team conversations (C71-D) and the groups built on them (C71-G): what the
// command layer reaches through the package index, which re-exports this file whole (moved here to keep the
// index under its line cap).

export {
  CONVERSATION_TYPE_KEY,
  directConversation,
  listConversations,
  lockConversation,
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
export { isStaff } from './staff.ts';
export { currentConversations, readConversationMentions } from './members.ts';
export { readPositionOf, type ReadPosition } from './read-position.ts';
// Chat writes and access changes queue on the one access lock (C71-D).
export { shareAccessLock } from '../authority/access.ts';
