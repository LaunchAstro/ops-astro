// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it } from 'vitest';
import { unmountAll } from './mp-7-11-drawer-fixtures.tsx';
import { drawerFor, serving, STORED } from './drawer-history-support.tsx';

afterEach(unmountAll);

it('an uppercase stored assistant ID remains outside its closed kept-tab shape', async () => {
  const id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  sessionStorage.setItem(
    'ops-astro:drawer-tabs:alpha:ana',
    JSON.stringify({ selected: id, tabs: [id] }),
  );
  const { client, calls } = serving(STORED);
  await drawerFor(client);
  expect(calls.filter((call) => call.name === 'conversation.read')).toEqual([]);
  expect(calls.some((call) => JSON.stringify(call.body).includes(id))).toBe(false);
});
