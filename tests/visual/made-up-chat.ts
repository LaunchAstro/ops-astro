// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up answers for the Team panel's two chat reads (C71-D, C71-G),
// among the people every made-up read shares. Typed against the wire
// contract's read shapes, as `made-up-api.ts` is; test side only.
//
// One direct conversation with Mia, read to its end, and one group with two
// of Mia's messages past Nathan's marker. The panel opens on a conversation
// with something unread, so it opens on the group and leaves Mia's face
// unselected, as the mockup's strip draws it. Each conversation's messages
// are answered by its id; each unread is the count of others' messages after
// the marker, as the panel derives it.

import type {
  ChatConversationsResult,
  ChatMessagesResult,
} from '../../packages/core-wire/src/index.ts';
import { MIA, NATHAN } from './made-up-access.ts';

const fromMia = { authorId: MIA.personId, author: MIA.name } as const;
const fromNathan = { authorId: NATHAN.personId, author: NATHAN.name } as const;

const MESSAGES = {
  'cv-mia': {
    ok: true,
    conversationId: 'cv-mia',
    lastRead: '2026-09-25T22:10:00.000Z',
    messages: [
      {
        id: 'm-1',
        ...fromMia,
        at: '2026-09-25T21:40:00.000Z',
        body: 'Meridian want the hero copy before Friday. Can you look at it tonight?',
      },
      {
        id: 'm-2',
        ...fromNathan,
        at: '2026-09-25T21:52:00.000Z',
        body: 'Yes, after dinner. Is the ad overspend in the draft?',
      },
      {
        id: 'm-3',
        ...fromMia,
        at: '2026-09-25T22:05:00.000Z',
        body: 'Not yet. I have put it on T-9 for your sign-off.',
      },
      {
        id: 'm-4',
        ...fromNathan,
        at: '2026-09-25T22:10:00.000Z',
        body: 'Thanks. I will sign it off first thing.',
      },
    ],
  },
  'cv-harbour': {
    ok: true,
    conversationId: 'cv-harbour',
    lastRead: '2026-09-25T19:00:00.000Z',
    messages: [
      {
        id: 'm-5',
        ...fromNathan,
        at: '2026-09-25T19:00:00.000Z',
        body: 'The shopping feed clean-up has finished. Its receipt is on T-17.',
      },
      {
        id: 'm-6',
        ...fromMia,
        at: '2026-09-25T19:20:00.000Z',
        body: 'Thanks. I will check the feed against their price list in the morning.',
      },
      {
        id: 'm-7',
        ...fromMia,
        at: '2026-09-25T19:24:00.000Z',
        body: 'Their four review replies are drafted too, on T-13 for approval.',
      },
    ],
  },
} as const satisfies Record<string, ChatMessagesResult>;

export const CONVERSATIONS: ChatConversationsResult = {
  ok: true,
  conversations: [
    {
      conversationId: 'cv-mia',
      kind: 'direct',
      name: null,
      members: [NATHAN.personId, MIA.personId],
      joinedAt: '2026-09-01T09:00:00.000Z',
      lastRead: '2026-09-25T22:10:00.000Z',
      lastMessageAt: '2026-09-25T22:10:00.000Z',
      unread: 0,
    },
    {
      conversationId: 'cv-harbour',
      kind: 'group',
      name: 'Harbour Physio launch',
      members: [NATHAN.personId, MIA.personId],
      joinedAt: '2026-09-01T09:00:00.000Z',
      lastRead: '2026-09-25T19:00:00.000Z',
      lastMessageAt: '2026-09-25T19:24:00.000Z',
      unread: 2,
    },
  ],
};

/** The direct conversation's messages: the read's default answer. */
export const DIRECT_MESSAGES: ChatMessagesResult = MESSAGES['cv-mia'];

/** The messages `chat.messages` answers for the conversation asked for; nothing for one it does not hold. */
export function messagesOf(conversationId: unknown): ChatMessagesResult | undefined {
  const id = String(conversationId);
  return Object.hasOwn(MESSAGES, id) ? MESSAGES[id as keyof typeof MESSAGES] : undefined;
}
