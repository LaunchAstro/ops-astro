// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// S1920-2's class (register 78): every write a fold leaves goes as the tab
// stands when it is sent, not as it stood at the fold. A rename made while
// the fresh start's own page write is still out queues ahead of the fold's
// title correction, so the correction must carry that rename, never undo it.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { opened, settled, standIn, tabs, tabTitle, view } from './resend-fixture.tsx';

afterEach(unmountAll);

it('a title chosen while a fold waits on the start page write wins over its correction', async () => {
  const api = standIn({
    'conversation.start': ['hold'],
    'conversation.set_scope': ['answer', 'hold'],
  });
  const drawer = await opened(api.client);
  await drawer.addPage();
  await drawer.ask('A');
  const [id] = api.server.keys();
  if (!id) throw new Error('start was not committed');
  await drawer.rename('chat-2', 'Named here');
  await drawer.reopen(id);
  await drawer.page.render(view(api.client, { here: '/task/T-13' }));
  await drawer.addPage();
  await drawer.rename('chat-3', 'Named in the twin');
  api.release();
  await settled();
  expect(tabs()).toEqual(['chat-1', 'chat-2']);
  await drawer.rename('chat-2', 'Named last');
  api.release();
  await settled();
  await settled();
  expect(tabTitle('chat-2')).toBe('Named last');
  expect(api.server.get(id)?.title, 'the last title chosen is the server final value').toBe(
    'Named last',
  );
});
