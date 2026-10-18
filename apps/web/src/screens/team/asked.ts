// SPDX-License-Identifier: AGPL-3.0-only
//
// The conversation a notification's door asks Team to open: `?conversation=<id>`
// on the address, the page's or the dock panel's place. A group opens by its
// id, a direct conversation by the teammate in it; one the reader no longer
// has opens nothing in particular.

import { talkOf, type ChatModel } from './chat.ts';
import type { Talk } from './outbox.ts';

/** The reader's conversations once settled, opened on the one the address asks for. */
export function talkFor(chat: ChatModel, me: string, address?: string): Talk | null {
  const talk = chat.settled ? talkOf(chat, me) : null;
  const asked = new URLSearchParams(address?.split('?')[1]?.split('#')[0] ?? '').get(
    'conversation',
  );
  const { list } = chat;
  if (talk === null || asked === null || list === null || list === 'none') return talk;
  const wanted = list.find((view) => view.conversationId === asked);
  if (wanted === undefined) return talk;
  if (wanted.kind === 'group')
    return { ...talk, asked: { kind: 'group', id: wanted.conversationId } };
  const other = wanted.members.find((person) => person !== me);
  return other === undefined ? talk : { ...talk, asked: { kind: 'person', id: other } };
}
