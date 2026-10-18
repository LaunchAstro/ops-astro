// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Sol's proof for S1920-2 on #1920 (d318733), moved by behaviour (register 78:
// the fix rides in #1927). A fold's page correction waits behind the fresh
// start's own page write; a page the person chooses during that wait must
// still be the page the server ends on, never the one the fold picked.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { bodiesOf, opened, settled, standIn, view, lines, tabs } from './resend-fixture.tsx';

afterEach(unmountAll);

it('a page chosen after the fold wins over the correction queued after a held start page write', async () => {
  const api = standIn({
    'conversation.start': ['hold'],
    'conversation.set_scope': ['answer', 'hold'],
  });
  const drawer = await opened(api.client);
  await drawer.addPage();
  await drawer.ask('A');
  const [id] = api.server.keys();
  if (!id) throw new Error('start was not committed');
  await drawer.reopen(id);
  await drawer.page.render(view(api.client, { here: '/task/T-13' }));
  await drawer.addPage();
  expect(api.server.get(id)?.page?.address).toBe('/task/T-13');
  api.release();
  await settled();
  expect(tabs()).toEqual(['chat-1', 'chat-2']);
  expect(api.server.get(id)?.page?.address).toBe('/task/T-12');
  await drawer.page.render(view(api.client, { here: '/task/T-14' }));
  await drawer.addPage();
  expect(lines().join(' ')).toContain('/task/T-14');
  api.release();
  await settled();
  await settled();
  expect(
    bodiesOf(api.bodies, 'conversation.set_scope').map(
      (b) => (b['page'] as { address: string }).address,
    ),
  ).toContain('/task/T-14');
  expect(
    api.server.get(id)?.page?.address,
    'the latest stamped page must be the server final value',
  ).toBe('/task/T-14');
});
