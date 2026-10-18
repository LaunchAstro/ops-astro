// SPDX-License-Identifier: AGPL-3.0-only
//
// #1467: a tab's page note, the drawer's claim that its page is read into context. Only a task's
// page is read (as the server parses it); any other page is said not to be. Each question keeps the
// address of the page in scope when it was asked. A refusal for its page takes the claim back only
// when it answers a question asked on the page the note still names, so a late refusal for an older
// page or question leaves the note of a page added since alone. The drawer is given the refusal's
// words, not its code, so the question it answers (`after`) comes through the store.

import type { AssistantMessage, AssistantPage } from '@launchastro/ui';

/**
 * A task's page, the one kind the server reads: `taskPageRef` in `core-records`, which the browser
 * cannot load. The page note's test holds the two equal.
 */
const TASK_PAGE = /^\/task\/[^/?#]+$/u;

export interface Noted {
  readonly page: AssistantPage | null;
  readonly messages: readonly AssistantMessage[];
  /** Each question's line id, with the address of the page in scope when it was asked. */
  readonly asked?: Readonly<Record<string, string | null>>;
  /** The page this tab gave up to a lost start, which a replay of it puts back (#897). */
  readonly gave?: AssistantPage | null;
}

const noteOf = (page: AssistantPage): string =>
  TASK_PAGE.test(page.address)
    ? `Read this page into context — every widget on ${page.address}, and nothing else.`
    : 'This page can’t be read into context, so nothing on it is sent.';

/** Tab `chat` with `page` in scope; a second one replaces the first, and its note with it. */
export const noted = <T extends Noted>(chat: T, page: AssistantPage): T => ({
  ...chat,
  page,
  messages: [
    ...chat.messages.filter((message) => message.id !== 'page'),
    { id: 'page', role: 'note', body: noteOf(page), cites: [] },
  ],
});

/**
 * Whether `line` refuses, for its page (`conversation-replies.ts`'s words), the question `after`
 * asked on the page now in scope.
 */
const refuses = (chat: Noted, line: AssistantMessage, after: string | undefined): boolean =>
  line.role === 'failed' &&
  line.body.startsWith('Models are off for') &&
  after !== undefined &&
  chat.page !== null &&
  chat.asked?.[after] === chat.page.address;

const UNREAD = 'This page couldn’t be read into context, so nothing on it was sent.';

/** Tab `chat` with `line` added, answering the question `after` when it is an answer. */
export const told = <T extends Noted>(chat: T, line: AssistantMessage, after?: string): T => ({
  ...chat,
  ...(line.role === 'user' && { asked: { ...chat.asked, [line.id]: chat.page?.address ?? null } }),
  messages: [
    ...(refuses(chat, line, after)
      ? chat.messages.map((each) => (each.id === 'page' ? { ...each, body: UNREAD } : each))
      : chat.messages),
    line,
  ],
});

export const GAVE_UP =
  'This page went with the question waiting for its answer. Add it again to ask with it here.';

/**
 * Tab `chat` without its page, which went with a start whose answer was lost: the page sends
 * record content (every widget on it), so one add reaches one conversation (#897).
 */
export const gaveUp = <T extends Noted>(chat: T): T => ({
  ...chat,
  page: null,
  gave: chat.page,
  messages: chat.messages.map((each) => (each.id === 'page' ? { ...each, body: GAVE_UP } : each)),
});

/** Tab `chat` with the page it gave up back, its note where it was. */
export const putBack = <T extends Noted>(chat: T, page: AssistantPage): T => ({
  ...chat,
  page,
  gave: null,
  messages: chat.messages.map((each) =>
    each.id === 'page' ? { ...each, body: noteOf(page) } : each,
  ),
});
