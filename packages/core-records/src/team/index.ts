// SPDX-License-Identifier: AGPL-3.0-only
//
// Team conversations (C71-D): what the command layer reaches through the
// package index, which re-exports this file whole (moved here to keep the
// index under its line cap).

export {
  CONVERSATION_TYPE_KEY,
  directConversation,
  isStaff,
  listConversations,
  lockConversation,
  moveReadMarker,
  readConversation,
  readConversationTypes,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationTypes,
} from './conversations.ts';
export { readPositionOf, type ReadPosition } from './read-position.ts';
// Chat writes and access changes queue on the one access lock (C71-D).
export { shareAccessLock } from '../authority/access.ts';
