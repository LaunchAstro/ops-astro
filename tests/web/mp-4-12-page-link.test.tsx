// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-12, the page link in the dock task panel (CS-4.4, CS-4.22, DP-03,
// DP-29, DP-30): Link here takes the address being read, its path and hash,
// through task.update at the read revision; once linked the panel draws the
// link and the head's go-to, and Link here becomes Relink. A stored address
// outside the product is drawn as words, never as a door. The pin (CS-4.7,
// DP-10) waits on the preference model; the captures on MP-1-7.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unmountAll } from './perspective-support.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

beforeEach(() => {
  window.history.pushState({}, '', '/clients/acme?tab=notes#brief');
});

describe('MP-4-12 link here captures path and hash', () => {
  it('Link here sends the address being read, path and hash, at the read revision', async () => {
    const { client, sent } = serving();
    const view = await panel(client);
    expect(view.find('[data-page-link="set"]')?.textContent).toBe('Link here');
    await view.click('[data-page-link="set"]');
    await tick();
    expect(sent.map((each) => [each.to, each.body])).toStrictEqual([
      [
        '/task/update',
        expect.objectContaining({
          recordId: TASK_ID,
          expectedRevision: 4,
          fields: { page_link: '/clients/acme#brief' },
        }),
      ],
    ]);
    await view.unmount();
  });

  it('once linked it reads Relink and re-points the link to the address being read', async () => {
    const { client, sent } = serving({ pageLink: '/boards/website#row-4' });
    const view = await panel(client);
    expect(view.find('[data-page-link="set"]')?.textContent).toBe('Relink');
    await view.click('[data-page-link="set"]');
    await tick();
    expect(sent.map((each) => each.body['fields'])).toStrictEqual([
      { page_link: '/clients/acme#brief' },
    ]);
    await view.unmount();
  });
});

describe('MP-4-12 the head’s go-to appears only when linked', () => {
  it('with no link there is no go-to and no link drawn', async () => {
    const view = await panel(serving().client);
    expect(view.find('[data-panel-head="goto"]')).toBeNull();
    expect(view.find('a[data-page-link="value"]')).toBeNull();
    await view.unmount();
  });

  it('linked, the go-to and the value both lead to the address, the full address in its title', async () => {
    const view = await panel(serving({ pageLink: '/boards/website#row-4' }).client);
    expect(view.find('[data-panel-head="goto"]')?.getAttribute('href')).toBe(
      '/boards/website#row-4',
    );
    const value = view.find('a[data-page-link="value"]');
    expect([value?.getAttribute('href'), value?.getAttribute('title')]).toStrictEqual([
      '/boards/website#row-4',
      '/boards/website#row-4',
    ]);
    await view.unmount();
  });

  it.each(['javascript:alert(1)', '//example.test/x', 'https://example.test/x', '/\\example.test'])(
    'a stored %s is drawn as words, never as a door',
    async (link) => {
      const view = await panel(serving({ pageLink: link }).client);
      expect(view.find('[data-panel-head="goto"]')).toBeNull();
      expect(view.find('a[data-page-link="value"]')).toBeNull();
      expect(view.find('[data-page-link="value"]')?.textContent).toBe(link);
      await view.unmount();
    },
  );
});

describe('MP-4-12 pin comes back as drawn', () => {
  it.todo('the star pins the task to the top of this person’s own list (no preference model yet)');
});

describe('MP-4-12 visual match', () => {
  it.todo('matches the mockup at 1480, 900 and 390, light and dark (MP-1-7 harness)');
});
