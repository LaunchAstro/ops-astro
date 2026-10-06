// SPDX-License-Identifier: AGPL-3.0-only
//
// The team conversation reads (C71-D): the reader's conversations with their
// unread, and one conversation's messages. `chat:comment` is asked of the
// business by the catalogue row; within it, the reader's own membership is the
// filter inside each query (`core-records/src/team/conversations.ts`), so the
// owner and administrators read only their own. Staff only: anyone else is
// answered as for a thing they cannot see.

import {
  listConversations,
  readConversation,
  readConversationTypes,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { ChatConversationsResult, ChatMessagesResult } from '../../../core-wire/src/index.ts';
import { refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { isInternalReader } from './tasks.ts';

export async function readChatConversations(
  tx: TenantQuery,
  session: Session,
): Promise<ChatConversationsResult | CommandRefusal> {
  if (!isInternalReader(session.roleKey)) return refuseNotFound();
  const types = await readConversationTypes(tx);
  return {
    ok: true,
    conversations: types === undefined ? [] : await listConversations(tx, types, session.personId),
  };
}

export async function readChatMessages(
  tx: TenantQuery,
  session: Session,
  conversationId: string,
): Promise<ChatMessagesResult | CommandRefusal> {
  if (!isInternalReader(session.roleKey)) return refuseNotFound();
  const types = await readConversationTypes(tx);
  const read =
    types === undefined
      ? undefined
      : await readConversation(tx, types, conversationId, session.personId);
  return read === undefined ? refuseNotFound() : { ok: true, conversationId, ...read };
}
