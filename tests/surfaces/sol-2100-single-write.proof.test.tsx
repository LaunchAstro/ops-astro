// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { answered, block, drawer } from './chat-proposal-drawer.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';
afterEach(unmountAll);
it('Sol proof, criterion 1: accepting a site plan performs no second write', async () => {
  const sitePages = [{ repository: 'agency-astro/site', page: 'https://agencyastro.com/about' }];
  const body = block(
    JSON.stringify({
      action: 'site_change',
      title: 'About correction',
      page: sitePages[0]!.page,
      before: 'Brisbane',
      after: 'Townsville',
      client: 'internal',
      estimate: 15,
    }),
  );
  const view = await drawer({ replies: [{ ...answered(body), sitePages }] });
  track(view.page);
  await view.ask('Change Brisbane to Townsville on the About page');
  await view.click();
  // Count every mutation after the conversation, including task.assign.
  expect(
    view.sent.filter((call) => !call.name.startsWith('conversation.')).map((call) => call.name),
  ).toEqual(['task.create']);
});
