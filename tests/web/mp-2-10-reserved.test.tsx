// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-10, reserved and undesigned addresses (rulings R1, R2 and R3). An
// address the mockup never designed stays out of the rail and the tab rows,
// and typing it shows the one shared "not here yet" state, as does any page
// whose own ticket has not landed. `/dashboard/` is Portfolio Command's
// address and `/` goes there. Looks at 1480, 900 and 390, light and dark, are
// measured in a browser by `tests/browser/app-frame.mjs`.

// oxlint-disable no-await-in-loop

import { describe, expect, it } from 'vitest';
import { canonicalOf } from '../../apps/web/src/legacy.ts';
import { PAGES, SECTIONS, pageAt } from '../../apps/web/src/manifest.ts';
import { matchRoute } from '../../apps/web/src/routes.ts';
import { filled, hrefs, open } from './mp-2-1-support.tsx';

/**
 * The R2 list: the reserved addresses the mockup never designed. Access (C32)
 * and Telemetry (C34) left it once built (ORCH37).
 */
const UNDESIGNED = [
  '/docs/',
  '/docs/snippets/',
  '/settings/keys/',
  '/settings/emails/',
  '/settings/workflow-triggers/',
  '/settings/cal/',
];

describe('MP-2-10 the reserved addresses in the route table', () => {
  it('marks exactly the R2 addresses undesigned', () => {
    const marked = PAGES.filter((page) => !page.designed).map((page) => page.path);
    expect(marked).toEqual(UNDESIGNED);
  });

  it('answers every reserved address with the shared state, never a missing page', async () => {
    for (const address of UNDESIGNED) {
      const { view } = await open(address);
      expect(view.find('[data-outcome="not-found"]'), address).toBeNull();
      expect(view.find('[data-outcome="placeholder"]'), address).not.toBeNull();
      await view.unmount();
    }
  });
});

describe('MP-2-10 each undesigned address stays out of the navigation, and a typed address shows the one shared empty state', () => {
  it('leaves every undesigned address out of the rail and the tabs on every page', async () => {
    for (const page of PAGES) {
      const { view } = await open(filled(page.path));
      const drawn = hrefs(view);
      for (const address of UNDESIGNED) expect(drawn, page.path).not.toContain(address);
      await view.unmount();
    }
  });

  it('draws one plain empty state for an unbuilt page and a typed undesigned one alike', async () => {
    const drawn = new Set<string>();
    for (const address of ['/settings/keys/', '/inbox/', '/clients/acme-dental/library/voice/']) {
      const { view } = await open(address);
      const state = view.find('[data-outcome="placeholder"]');
      expect(state?.querySelector('.empty__title')?.textContent, address).toBe('Not here yet');
      drawn.add(state?.querySelector('.empty__desc')?.textContent ?? '');
      expect(view.text(), address).not.toMatch(/placeholder page|route contract|port handoff/iu);
      expect(view.all('.card'), address).toHaveLength(0);
      await view.unmount();
    }
    expect([...drawn]).toEqual(["This page isn't built yet."]);
  });

  it('keeps the page and its ticket on the state for the record, not in its words', async () => {
    const { view } = await open('/inbox/');
    const state = view.find('[data-outcome="placeholder"]') as HTMLElement | null;
    expect(state?.dataset['page']).toBe('agency:inbox/inbox');
    expect(state?.dataset['ticket']).toBe('MP-7-3');
    expect(state?.textContent).not.toContain('MP-7-3');
    await view.unmount();
  });

  it('drops a section from the rail when none of its pages is designed', () => {
    const docs = SECTIONS.find((each) => each.namespace === 'agency' && each.id === 'docs');
    expect(docs?.navigable).toBe(false);
    const settings = SECTIONS.find((each) => each.namespace === 'agency' && each.id === 'general');
    expect(settings?.navigable).toBe(true);
    expect(settings?.tabs.map((page) => page.label)).toEqual(['General', 'Access', 'Telemetry']);
  });
});

describe('MP-2-10 /dashboard/ shows Portfolio Command (R1)', () => {
  it("makes /dashboard/ Portfolio Command's address and drops the separate Portfolio tab", async () => {
    expect(pageAt('/dashboard/')?.page.ticket).toBe('MP-14-1');
    expect(pageAt('/dashboard/')?.page.label).toBe('Portfolio');
    expect(canonicalOf('/agency/portfolio/')).toBe('/dashboard/');
    const { view } = await open('/dashboard/');
    expect(hrefs(view)).not.toContain('/dashboard/portfolio/');
    expect(view.all('[data-tabs] a').map((a) => a.textContent)).toEqual(['Portfolio', 'Executive']);
    await view.unmount();
  });
});

describe('MP-2-10 no launcher page: / goes to /dashboard/ (R3)', () => {
  it('sends a signed-in person at / to /dashboard/', async () => {
    const { seen } = await open('/');
    expect(seen.at(-1)).toBe('/dashboard/');
    expect(matchRoute('/index.html')).toBeNull();
  });
});

describe('MP-2-10 CS-2.11 none in the product: a mockup index', () => {
  it('answers /index.html as an unknown address, not a launcher', async () => {
    const { view } = await open('/index.html');
    expect(view.find('[data-outcome="not-found"]')).not.toBeNull();
    expect(view.all('.vcard, .cards')).toHaveLength(0);
    await view.unmount();
  });
});
