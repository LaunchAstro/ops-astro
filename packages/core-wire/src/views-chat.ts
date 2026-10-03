// SPDX-License-Identifier: AGPL-3.0-only
//
// The team conversation reads' answers (C71-D), beside `views.ts`. Every
// conversation and message here is one the reader is a member of: the server
// filters by membership inside the query, so nothing is withheld in a count.

/** One of the reader's conversations, with its unread derived from their own marker. */
export interface ChatConversationView {
  readonly conversationId: string;
  readonly kind: 'direct' | 'group';
  /** A group's name; null on a direct conversation, which is named by its other member. */
  readonly name: string | null;
  /** Every current member's person id, the reader included. */
  readonly members: readonly string[];
  /** Where the reader's own marker sits; null before they have read any of it. */
  readonly lastRead: string | null;
  readonly lastMessageAt: string | null;
  /** Others' messages after the reader's marker. */
  readonly unread: number;
}

export interface ChatConversationsResult {
  readonly ok: true;
  readonly conversations: readonly ChatConversationView[];
}

/** One message: a comment on the one comment record, as its conversation's member reads it. */
export interface ChatMessageView {
  readonly id: string;
  /** The author's person id. */
  readonly authorId: string;
  readonly author: string;
  readonly at: string;
  readonly body: string;
}

export interface ChatMessagesResult {
  readonly ok: true;
  readonly conversationId: string;
  readonly lastRead: string | null;
  /** Oldest first, from when the reader joined to when they left. */
  readonly messages: readonly ChatMessageView[];
}

/** A team conversation an inbox item is about (C71): a group's name, null on a direct one. */
export interface InboxConversation {
  readonly conversationId: string;
  readonly kind: 'direct' | 'group';
  readonly name: string | null;
}
