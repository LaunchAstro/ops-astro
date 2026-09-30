// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 on the page. Each tab keeps the seat its stream is handed, re-reads who
// else is on the task when the stream says presence changed, and marks the
// field it is editing (server and tabs: `c2-presence-support.tsx`).

import { afterEach, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { PagePresenceProvider, StripPresence } from '../../apps/web/src/views/presence.tsx';
import { mount } from './mount.tsx';
import {
  DUE,
  clients,
  closeAll,
  focus,
  onStrip,
  onTask,
  opened,
  server,
  tab,
  until,
} from './c2-presence-support.tsx';

afterEach(closeAll);

it('C2 presence shown (task) on the page: each teammate sees the other, and who is editing the due date', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const ben = await tab(api, 'ben');
  await until('each sees the other', () => onTask(ben).includes('Ana Ng is viewing'));
  await until('and the other way', () => onTask(ana).includes('Ben Ode is viewing'));

  await focus(ana, DUE, true);
  await until('Ben sees Ana editing the due date', () =>
    onTask(ben).includes('Ana Ng is editing Due date'),
  );
  expect(onTask(ana)).toBe('Ben Ode is viewing');

  await focus(ana, DUE, false);
  await until('back to viewing', () => onTask(ben).includes('Ana Ng is viewing'));

  await ana.unmount();
  opened.splice(opened.indexOf(ana), 1);
  await until('Ana has gone at once', () => !onTask(ben).includes('Ana Ng'));
  await ben.unmount();
  opened.splice(0);
  await until('everyone has gone, nothing held', () => api.book.held === 0);
});

it('C2 presence shown (page): the app strip shows who else is on this page from the same book, never the team list', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const ben = await tab(api, 'ben');
  const elsewhere = await tab(api, 'cleo', 'TSK-3');
  await until('the strip names Ana on Ben’s page', () => onStrip(ben).includes('Ana Ng'));
  // Exactly who is here: the team list's Dee, on no page, is not drawn.
  expect(onStrip(ben)).toEqual(['Ana Ng']);
  expect(onStrip(ana)).toEqual(['Ben Ode']);
  expect(onStrip(elsewhere)).toEqual([]);
  // Each face is the kit's avatar in the kit's stack (DS-PRIM-16), named for a screen reader.
  const face = ben.find('[data-presence="page"] .avstack .av.av--person');
  expect(face?.getAttribute('role')).toBe('img');
  expect(face?.getAttribute('aria-label')).toBe('Ana Ng');
  expect(face?.textContent).toBe('AN');

  await ana.unmount();
  opened.splice(opened.indexOf(ana), 1);
  await until('the strip empties when Ana leaves', () => onStrip(ben).length === 0);

  // Back on Ana's side: her tab's page closes and the strip keeps nobody from it.
  const back = await tab(api, 'ana');
  await until('Ana sees Ben again', () => onStrip(back).includes('Ben Ode'));
  await back.render(
    <PagePresenceProvider>
      <StripPresence />
    </PagePresenceProvider>,
  );
  expect(onStrip(back)).toEqual([]);
});

it('C2 a client session neither sees staff presence nor is seen (page)', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const cleo = await tab(api, 'cleo');
  await focus(cleo, DUE, true);
  await until('the client tab has marked', () =>
    api.marks.some((mark) => mark.startsWith('cleo ')),
  );
  // A teammate arriving makes Ana's page read again, with the client seated
  // and marked: she sees Ben, and only Ben.
  await tab(api, 'ben');
  await until('Ana sees Ben', () => onTask(ana).includes('Ben Ode'));

  expect(onTask(ana)).toBe('Ben Ode is viewing');
  expect(onStrip(ana)).toEqual(['Ben Ode']);
  expect(onTask(cleo)).toBe('');
  expect(onStrip(cleo)).toEqual([]);
  expect(cleo.text()).not.toContain('Ana Ng');
  expect(ana.text()).not.toContain('Cleo Client');
});

it('C2 a stream joined again carries the field still being edited to its new seat', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const ben = await tab(api, 'ben');
  await focus(ana, DUE, true);
  await until('Ben sees the edit', () => onTask(ben).includes('Ana Ng is editing Due date'));

  // A second page in Ana's tab follows another task, so her stream joins
  // again naming both, and is handed a new seat.
  const client = clients.get('ana');
  if (client === undefined) throw new Error('no client');
  opened.push(await mount(<TaskDetailScreen client={client} grantKey="ana:g" taskKey="TSK-3" />));
  await until('a new seat', () => (api.seats.get('ana') ?? []).length === 2);
  const renewed = api.seats.get('ana')?.[1] ?? '';
  await until('the edit is marked on the new seat', () =>
    api.marks.some((mark) => mark.includes(renewed) && mark.includes('"field":"due"')),
  );
  await until('Ben still sees the edit', () => onTask(ben).includes('Ana Ng is editing Due date'));

  // A page opened on a topic the stream already names reads through the seat it has.
  opened.push(await mount(<TaskDetailScreen client={client} grantKey="ana:g" taskKey="TSK-2" />));
  const again = opened.at(-1);
  await until(
    'the new page sees Ben',
    () => again !== undefined && onTask(again) === 'Ben Ode is viewing',
  );
});
