// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A question whose answer was lost after the server may have committed it is
// resent under the identity and the request it first went with, so the
// server's register replays the first attempt. Only a success of that same
// identity ends it: not a refusal of a replay, and not another send's answer
// arriving late. A question refused on its own first answer, a changed one,
// or one asked again after its answer, goes afresh. The production client
// runs the real send path over a stand-in API; this proves the identities
// sent, and the real-register suite proves the rows. A lost start replayed
// after another question started the tab answers in a tab on its own
// conversation, and the asking tab stays on the conversation it is on.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { APART } from '../../apps/web/src/assistant/first-question.ts';
import { settle } from '../surfaces/mount.tsx';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { drawer, identities, standIn } from './resend-fixture.tsx';

afterEach(unmountAll);

it('a first question resent after its start answer was lost replays the start: one conversation', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  await (
    await drawer(api.client)
  )('What is due today?', 'What is due today?');
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBe(starts[0]);
  expect(api.committed).toEqual(['conversation.start']);
});

it('a later question resent after its answer was lost replays the message: one message', async () => {
  const api = standIn({ 'conversation.message': ['drop'] });
  await (
    await drawer(api.client)
  )('First question', 'Second question', 'Second question');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1]).toBe(messages[0]);
  expect(api.committed).toEqual(['conversation.start', 'conversation.message']);
});

it('a resend refused after a lost answer keeps the identity, and the next resend replays the first attempt', async () => {
  const api = standIn({ 'conversation.start': ['drop'] }, { 'conversation.start': ['refuse'] });
  const question = 'What is due today?';
  await (
    await drawer(api.client)
  )(question, question, question);
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toHaveLength(3);
  expect(new Set(starts).size).toBe(1);
  expect(api.committed).toEqual(['conversation.start']);
});

it('an older answer arriving late never clears a newer lost question', async () => {
  const api = standIn({ 'conversation.message': ['hold', 'drop'] });
  const ask = await drawer(api.client);
  await ask('First question', 'Second question', 'Third question');
  api.release();
  await settle();
  await ask('Third question');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(3);
  expect(messages[2]).toBe(messages[1]);
  expect(api.committed).toEqual([
    'conversation.start',
    'conversation.message',
    'conversation.message',
  ]);
});

it('a question refused on its own first answer, then resent, goes again under a fresh identity', async () => {
  const api = standIn({ 'conversation.start': ['refuse'] });
  await (
    await drawer(api.client)
  )('What is due today?', 'What is due today?');
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[1]).not.toBe(starts[0]);
});

it('a changed question after a lost answer goes under a fresh identity', async () => {
  const api = standIn({ 'conversation.message': ['drop'] });
  await (
    await drawer(api.client)
  )('First question', 'Second question', 'A different question');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1]).not.toBe(messages[0]);
});

it('the same question asked again after its answer came goes under a fresh identity', async () => {
  const api = standIn();
  await (
    await drawer(api.client)
  )('First question', 'Again', 'Again');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1]).not.toBe(messages[0]);
});

/** The drawer's tabs, the selected tab's address, and its lines as role and text. */
const tabs = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="tab"][data-chat]'),
];
const address = (): string | null | undefined =>
  document.querySelector('[data-assistant="address"]')?.getAttribute('href');
const lines = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-message-role]')].map(
    (line) => `${line.dataset['messageRole'] ?? ''}: ${line.textContent ?? ''}`,
  );

it('a lost first question replayed after another question started the tab answers in a tab on its own conversation, and the asking tab stays on its own', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  const ask = await drawer(api.client);
  await ask('Question A', 'Question B');
  const before = tabs().length;
  const asking = tabs().find((tab) => tab.getAttribute('aria-selected') === 'true');
  await ask('Question A');
  expect(api.committed).toEqual(['conversation.start', 'conversation.start']);
  // The stand-in numbers conversations as they commit: A's is 1, B's is 2.
  expect(address()).toBe('/agent/c0000000-0000-4000-8000-000000000001');
  expect(lines()).toEqual(['user: Question A', 'ai: ']);
  expect(tabs()).toHaveLength(before + 1);
  await act(() => {
    asking?.click();
  });
  await settle();
  expect(address()).toBe('/agent/c0000000-0000-4000-8000-000000000002');
  expect(lines().slice(-2)).toEqual(['user: Question A', `note: ${APART}`]);
});
