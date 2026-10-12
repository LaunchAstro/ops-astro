// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { randomUUID } from 'node:crypto';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { assign } from '../../apps/web/src/assistant/assignees.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { AssistantProposal } from '../../packages/ui/src/surfaces/assistant/types.ts';
import { ADA, answered, block, drawer, ok, type Answer } from './chat-proposal-drawer.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

const MIA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RAJ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const member = (personId: string, name: string) => ({ personId, name, availability: null });
const team = (...people: ReturnType<typeof member>[]) => ({
  ok: true as const,
  you: ADA,
  people: [member(ADA, 'Ada Lovelace'), ...people],
});
const naming = (name: string) =>
  block(JSON.stringify({ action: 'create', title: 'Book the printer', assignee: name }));
const lost = { unavailable: true, because: 'The reply was lost.' };

afterEach(async () => {
  vi.restoreAllMocks();
  await unmountAll();
});

it('a new card cannot assign from the previous team while its refresh is pending', async () => {
  let release: ((answer: Answer) => void) | undefined;
  const refreshed = new Promise<Answer>((resolve) => {
    release = resolve;
  });
  let list: Answer | Promise<Answer> = ok(team());
  const opened = await drawer({
    replies: [
      answered(block('{"action":"create","title":"Order toner"}')),
      { answered: true, messageId: randomUUID(), body: naming('Raj Patel') },
    ],
    get team() {
      return list as Answer;
    },
  });
  track(opened.page);
  await opened.ask('Order toner');
  await opened.click();
  list = refreshed;
  await opened.ask('Book the printer for Raj Patel');
  await opened.click();
  // eslint-disable-next-line require-await -- act's callback is async by its contract
  await act(async () => {
    release?.(ok(team(member(RAJ, 'Raj Patel'))));
  });
  expect(
    opened.assigned().map((write) => (write.body['fields'] as Answer)['assignee']),
  ).toStrictEqual([ADA, RAJ]);
});

it('a failed storage write cannot change the body of a live assignment retry', async () => {
  let list: Answer = ok(team(member(MIA, 'Mia Chen')));
  const opened = await drawer({
    replies: [
      answered(naming('Mia')),
      {
        answered: true,
        messageId: randomUUID(),
        body: block('{"action":"create","title":"Order toner"}'),
      },
    ],
    assigns: [lost],
    get team() {
      return list;
    },
  });
  track(opened.page);
  await opened.ask('Book the printer for Mia');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Site storage blocked');
  });
  await opened.click();
  const first = opened.assigned()[0];
  // eslint-disable-next-line no-unsafe-optional-chaining -- the assertion reads the first write as it was sent
  expect((first?.body['fields'] as Answer)['assignee']).toBe(MIA);
  list = ok(team(member(MIA, 'Mia Chen'), member(RAJ, 'Mia Park')));
  await opened.ask('Order toner');
  // The first send button is the first card's Send again, not the new card.
  await opened.click();
  const retry = opened.assigned()[1];
  expect(retry?.options['operationId']).toBe(first?.options['operationId']);
  expect(retry?.body).toStrictEqual(first?.body);
});

it('32 later assignments cannot evict an unresolved retry body', async () => {
  const sends: { name: string; body: Readonly<Record<string, unknown>>; options: unknown }[] = [];
  const client = {
    // eslint-disable-next-line require-await -- the stand-in answers as the client's async mutate does
    mutate: async (name: string, body: Readonly<Record<string, unknown>>, options: unknown) => {
      sends.push({ name, body, options });
      return lost;
    },
  } as unknown as OperationsClient;
  const source = randomUUID();
  const task = { recordId: randomUUID(), revision: 1 };
  const proposal: AssistantProposal = {
    action: 'create',
    title: 'Printer',
    description: null,
    assignee: 'Mia',
    state: 'offered',
    task: null,
    refusal: null,
  };
  const view = { client, grantKey: 'sol-1532', team: team(member(MIA, 'Mia Chen')) };
  await assign(view, proposal, source, task);
  const first = sends[0];
  for (let i = 0; i < 32; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- each assignment in turn, as a person clicks them
    await assign(view, proposal, randomUUID(), { recordId: randomUUID(), revision: 1 });
  }
  await assign(
    { ...view, team: team(member(MIA, 'Mia Chen'), member(RAJ, 'Mia Park')) },
    proposal,
    source,
    task,
  );
  const retry = sends.at(-1);
  expect(retry?.options).toStrictEqual(first?.options);
  expect(retry?.body).toStrictEqual(first?.body);
});
