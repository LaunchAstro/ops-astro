// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 on the page, out of order: an answer that arrives late never draws over
// a newer one, and marks reach the book in the order they were sent, so the
// field shown is the one the teammate is on now.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { mount } from './mount.tsx';
import {
  DUE,
  clients,
  closeAll,
  focus,
  onTask,
  opened,
  pause,
  server,
  tab,
  until,
} from './c2-presence-support.tsx';

afterEach(closeAll);

const TITLE = 'form[id="task-fields"] input[type="text"]';

const settle = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
  });
};

it('C2 races: a late presence answer never overwrites a newer one', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const ben = await tab(api, 'ben');
  await until('Ben sees Ana', () => onTask(ben) === 'Ana Ng is viewing');

  // Ben's next answer is read while Ana is on the title and arrives late.
  const release = api.hold('ben', 'presence');
  await focus(ana, TITLE, true);
  await focus(ana, TITLE, false);
  await focus(ana, DUE, true);
  await until('Ben sees the due date', () => onTask(ben) === 'Ana Ng is editing Due date');
  release();
  await settle();
  expect(onTask(ben)).toBe('Ana Ng is editing Due date');
});

it('C2 races: marks reach the book in the order sent', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const ben = await tab(api, 'ben');
  await until('Ben sees Ana', () => onTask(ben) === 'Ana Ng is viewing');

  // Ana's first mark is held on the way; she has already left the field.
  const release = api.hold('ana', 'mark');
  await focus(ana, DUE, true);
  await focus(ana, DUE, false);
  await settle();
  release();
  await until(
    'both marks applied',
    () => api.marks.filter((m) => m.startsWith('ana ')).length === 2,
  );
  await settle();
  expect(onTask(ben)).toBe('Ana Ng is viewing');
});

it('C2 races: a stream refused on joining again shows nobody, never the list it last had', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  await tab(api, 'ben');
  await until('Ana sees Ben', () => onTask(ana) === 'Ben Ode is viewing');

  // Another page in Ana's tab joins the stream again, and the join is refused.
  api.refusing.add('ana');
  const client = clients.get('ana');
  if (client === undefined) throw new Error('no client');
  opened.push(await mount(<TaskDetailScreen client={client} grantKey="ana:g" taskKey="TSK-3" />));
  await until('Ana shows nobody', () => onTask(ana) === '');
});
