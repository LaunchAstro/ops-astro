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
}

/** Tab `chat` with `page` in scope; a second one replaces the first, and its note with it. */
export const noted = <T extends Noted>(chat: T, page: AssistantPage): T => ({
  ...chat,
  page,
  messages: [
    ...chat.messages.filter((message) => message.id !== 'page'),
    {
      id: 'page',
      role: 'note',
      body: TASK_PAGE.test(page.address)
        ? `Read this page into context — every widget on ${page.address}, and nothing else.`
        : 'This page can’t be read into context, so nothing on it is sent.',
      cites: [],
    },
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

/** The question lines tab `chat` has so far: a switch chosen now is marked after them. */
export const askedSoFar = (chat: Noted | undefined): string[] =>
  chat?.messages.filter((one) => one.role === 'user').map((one) => one.id) ?? [];

/**
 * Tab `chat` with its change to `model` marked in the transcript (#2175), once
 * the server kept it, so the lines after it are read as the new model's. It goes
 * before the first question asked since the choice (one not in `earlier`), as
 * that question waited for the switch and went to the new model.
 */
export const switched = <T extends Noted>(
  chat: T,
  model: string,
  earlier: readonly string[],
): T => {
  const since = chat.messages.findIndex((one) => one.role === 'user' && !earlier.includes(one.id));
  const at = since === -1 ? chat.messages.length : since;
  const line: AssistantMessage = {
    id: `model-${String(chat.messages.length)}`,
    role: 'note',
    body: `Switched to ${model}. Questions from here go to it.`,
    cites: [],
  };
  return { ...chat, messages: [...chat.messages.slice(0, at), line, ...chat.messages.slice(at)] };
};
