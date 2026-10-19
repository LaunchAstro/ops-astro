// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A lost question's kept attempt belongs to the drawer it was asked in, and
// to the tab. The drawer is keyed by its grant, as `App.tsx` mounts it, so a
// switch of business, person or session drops the attempt: the same words
// asked afterwards go under a new operation id and show none of the old lines
// or scope. Two internal tabs on two tasks that each lose the same question
// each replay only their own first attempt, each with only its own task's
// scope. A tab on a client's task sends nothing at all (no client material is
// asked here, `modelOffer`), and takes no other tab's attempt.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { askDrawer, taskAsk } from '../../apps/web/src/assistant/asks.ts';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import {
  bodiesOf,
  identities,
  lines,
  opened,
  selectedTab,
  settled,
  standIn,
  tabs,
  TASK,
  view,
} from './resend-fixture.tsx';

afterEach(unmountAll);

const A = 'Question A';
const SECOND = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Second brief',
  clientId: null,
};
const CLIENT_TASK = {
  id: '77777777-7777-4777-8777-777777777777',
  title: 'Client brief',
  clientId: '88888888-8888-4888-8888-888888888888',
};

/** The selected tab's subject as its input names it, and its placeholder. */
const subject = () => {
  const input = document.querySelector<HTMLInputElement>('[data-assistant="input"]');
  return { label: input?.getAttribute('aria-label'), placeholder: input?.placeholder };
};

const onTask = (title: string) => ({
  label: `Ask the agent about ${title}`,
  placeholder: 'Ask about this task…',
});

/** Another task's ask delivered to the open drawer, as a task panel's head sends it. */
async function askAbout(task: Parameters<typeof taskAsk>[0], grantKey: string): Promise<void> {
  act(() => {
    askDrawer(taskAsk(task), grantKey);
  });
  await settled();
}

// Grant keys as `grantKeyOf` spells them: business, person, then the session's endings.
it.each([
  [
    'business',
    { business: 'alpha', grantKey: 'alpha:ada:0' },
    { business: 'beta', grantKey: 'beta:ada:0' },
  ],
  [
    'person',
    { business: 'beta', grantKey: 'beta:ada:0' },
    { business: 'beta', grantKey: 'beta:bob:0' },
  ],
  [
    'session',
    { business: 'beta', grantKey: 'beta:bob:0' },
    { business: 'beta', grantKey: 'beta:bob:1' },
  ],
])(
  'a switch of %s drops a lost question: asked again, it is new and shows nothing old',
  async (_, from, to) => {
    const api = standIn({ 'conversation.start': ['drop'] }, { 'conversation.start': ['refuse'] });
    const moves = await opened(api.clientFor(from.business), { grantKey: from.grantKey });
    await moves.ask(A, A);
    const kept = identities(api.sent, 'conversation.start');
    expect(kept, 'before the switch, a resend replays the kept attempt').toEqual([
      kept[0],
      kept[0],
    ]);
    await moves.page.render(view(api.clientFor(to.business), { grantKey: to.grantKey }));
    await settled();
    expect(tabs(), 'a fresh drawer').toEqual(['chat-1']);
    expect(lines()).toEqual([]);
    await moves.ask(A);
    const starts = identities(api.sent, 'conversation.start');
    expect(starts, 'a new operation id').toHaveLength(3);
    expect(starts[2]).not.toBe(starts[0]);
    expect(lines(), 'none of the old lines').toEqual([`user: ${A}`, 'ai: An answer.']);
    expect(subject().placeholder, 'none of the old scope').toBe('Ask about this page…');
    expect(bodiesOf(api.bodies, 'conversation.start')[2]?.['scope']).toBeNull();
  },
);

it('two internal tabs on two tasks each replay only their own lost question, with only their own scope', async () => {
  const api = standIn({ 'conversation.start': ['drop', 'drop'] });
  const moves = await opened(api.client, { grantKey: 'alpha:ada:0' });
  await moves.ask(A);
  await askAbout(SECOND, 'alpha:ada:0');
  expect(selectedTab()).toBe('chat-3');
  await moves.ask(A);
  await moves.select('chat-2');
  await moves.ask(A);
  expect(subject(), 'the first tab stays on the first task').toEqual(onTask(TASK.title));
  await moves.select('chat-3');
  await moves.ask(A);
  expect(subject(), 'the second tab stays on the second task').toEqual(onTask(SECOND.title));
  const starts = identities(api.sent, 'conversation.start');
  expect(starts, 'each resend replays its own tab’s first attempt').toEqual([
    starts[0],
    starts[1],
    starts[0],
    starts[1],
  ]);
  expect(starts[1]).not.toBe(starts[0]);
  const bodies = bodiesOf(api.bodies, 'conversation.start');
  expect(bodies[2], 'the first tab’s resend is its own first request').toEqual(bodies[0]);
  expect(bodies[3], 'the second tab’s resend is its own first request').toEqual(bodies[1]);
  expect(bodies.map((one) => one['scope'])).toEqual([
    { kind: 'task', id: TASK.id },
    { kind: 'task', id: SECOND.id },
    { kind: 'task', id: TASK.id },
    { kind: 'task', id: SECOND.id },
  ]);
  expect([...api.server.values()].map((one) => one.scope?.id)).toEqual([TASK.id, SECOND.id]);
});

it('a tab on a client’s task sends nothing, and takes no other tab’s lost question', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  const moves = await opened(api.client, { grantKey: 'alpha:ada:0' });
  await moves.ask(A);
  const lost = identities(api.sent, 'conversation.start');
  await askAbout(CLIENT_TASK, 'alpha:ada:0');
  expect(selectedTab()).toBe('chat-3');
  await moves.ask(A, A);
  expect(api.sent, 'the client tab sent no command').toHaveLength(1);
  expect(document.querySelector('[data-assistant="not-sent"]')).not.toBeNull();
  expect(
    lines().filter((line) => line.startsWith('user:')),
    'nor drew a question',
  ).toEqual([]);
  await moves.select('chat-2');
  await moves.ask(A);
  expect(identities(api.sent, 'conversation.start'), 'the internal tab replays its own').toEqual([
    lost[0],
    lost[0],
  ]);
});
