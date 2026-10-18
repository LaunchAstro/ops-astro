// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Sol's proof for S1920-1 on #1920 (9128ca1), moved by behaviour. A fresh
// start sends its page again once it lands, after a reopened twin's writes, so
// when the twin set a newer page the fold must write that page back last: the
// survivor and the server end on the same page.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { opened, settled, standIn, view, lines } from './resend-fixture.tsx';

afterEach(unmountAll);

it('a fresh start folding a twin preserves its newer page on the server', async () => {
  const api = standIn({ 'conversation.start': ['hold'] });
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
  await settled();
  expect(lines().join(' ')).toContain('/task/T-13');
  expect(
    api.server.get(id)?.page?.address,
    'the next question must use the page displayed by the survivor',
  ).toBe('/task/T-13');
});
