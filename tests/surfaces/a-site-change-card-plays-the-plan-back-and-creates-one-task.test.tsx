// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #1988: a reply ending in a site change block on a page the server gave with
// it draws the plan played back: the site, the page, the text before and
// after, who it is for and the estimate. Nothing is sent before the click;
// the click is the create card's one `task.create`, holding the plan section
// as the description and the estimate as the task's. A reply given no pages,
// or naming a page it was not given, draws no card; a kept tab reads its pages
// from `conversation.read`. The client is a recorder for the network only.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { answered, block, CONVERSATION, drawer, REPLY } from './chat-proposal-drawer.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const PAGES = [{ repository: 'agency-astro/site', page: 'https://agencyastro.com/about' }];
const SITE = block(
  JSON.stringify({
    action: 'site_change',
    title: 'About page: say Townsville',
    page: 'https://agencyastro.com/about',
    before: 'Based in Brisbane',
    after: 'Based in Townsville',
    client: 'internal',
    estimate: 15,
  }),
);
const SECTION = [
  'Site change plan',
  'Site: agency-astro/site',
  'Page: https://agencyastro.com/about',
  'Before: Based in Brisbane',
  'After: Based in Townsville',
  'Client: internal',
  'Estimate: 15 minutes',
].join('\n');

const site = (body = SITE, sitePages: unknown = PAGES) => ({ ...answered(body), sitePages });

// eslint-disable-next-line max-lines-per-function -- each leg of the card, in the page's order
describe('a site change card', () => {
  it('plays the plan back, and sends nothing before the click', async () => {
    const { page, ask, writes } = await drawer({ replies: [site()] });
    track(page);
    await ask('Change Brisbane to Townsville on the About page');
    const card = page.find('[data-proposal="card"]');
    expect(card?.textContent).toContain('Proposed site change');
    const shown = Object.fromEntries(
      page
        .all('[data-proposal-site]')
        .map((each) => [each.getAttribute('data-proposal-site'), each.textContent]),
    );
    expect(shown).toStrictEqual({
      site: 'agency-astro/site',
      page: 'https://agencyastro.com/about',
      before: 'Based in Brisbane',
      after: 'Based in Townsville',
      client: 'Internal',
    });
    expect(page.find('[data-proposal="estimate"]')?.textContent).toBe('Estimate 15m');
    expect(page.find('[data-proposal="description"]')).toBeNull();
    expect(page.text()).not.toContain('site_change');
    expect(writes()).toHaveLength(0);
  });

  it('one click creates the task with the plan section and the estimate, in one task.create', async () => {
    const { page, ask, click, writes } = await drawer({ replies: [site()] });
    track(page);
    await ask('Change Brisbane to Townsville on the About page');
    await click();
    expect(writes()).toStrictEqual([
      {
        name: 'task.create',
        body: {
          fields: {
            title: 'About page: say Townsville',
            description: SECTION,
            estimated_minutes: 15,
          },
          conversationId: CONVERSATION,
        },
        options: { operationId: `task-proposal:${REPLY}` },
      },
    ]);
  });

  it('draws no card for a reply given no pages, or naming a page it was not given', async () => {
    const elsewhere = [
      { repository: 'agency-astro/site', page: 'https://agencyastro.com/contact' },
    ];
    for (const reply of [answered(SITE), site(SITE, []), site(SITE, elsewhere), site(SITE, 'x')]) {
      // eslint-disable-next-line no-await-in-loop -- one drawer at a time
      const { page, ask, writes } = await drawer({ replies: [reply] });
      // eslint-disable-next-line no-await-in-loop -- one drawer at a time
      await ask('Change the About page');
      expect(page.find('[data-proposal="card"]')).toBeNull();
      expect(page.text()).toContain('```task');
      expect(writes()).toHaveLength(0);
      // eslint-disable-next-line no-await-in-loop -- one drawer at a time
      await page.unmount();
    }
  });

  it('a kept tab draws the card from the pages its read gives, and none without them', async () => {
    const live = await drawer({ replies: [site()] });
    await live.ask('Change Brisbane to Townsville on the About page');
    await live.page.unmount();
    const kept = await drawer({ kept: { body: SITE, scope: null, sitePages: PAGES } });
    expect(kept.page.find('[data-proposal-site="page"]')?.textContent).toBe(
      'https://agencyastro.com/about',
    );
    await kept.page.unmount();
    const bare = await drawer({ kept: { body: SITE, scope: null } });
    track(bare.page);
    expect(bare.page.find('[data-proposal="card"]')).toBeNull();
  });
});
