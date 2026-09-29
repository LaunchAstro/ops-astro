// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-1 isolation, at the address layer: two businesses, two clients, one
// grant each (Alpha's person on acme-dental, Bravo's on zenith-plumbing, both
// made up). The separations proved here:
//
// - business to business: a client address belonging to the other business
//   draws the shared refusal and names neither that client nor that business;
// - client to client: within the workspace and the portal, an address for a
//   client the person holds no grant on draws the same refusal, and a portal
//   address serves only its own client.
//
// The product has no client records yet (they arrive with MP-10-1), so the
// grant answer here is the `ClientAccess` seam the application is handed, and
// the default the entry supplies holds no client at all. The business half,
// against the real API and Postgres, is `mp-2-1-isolation-api.test.ts`.

// Sequential on purpose: each case is one fresh load, one mounted app at a time.
// oxlint-disable no-await-in-loop

import { describe, expect, it } from 'vitest';
import { NO_CLIENT_GRANTS, PAGES } from '../../apps/web/src/manifest.ts';
import { filled, open } from './mp-2-1-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

const scoped = PAGES.filter((page) => page.path.includes(':client'));

const refusalOf = (view: Mounted): string =>
  view.find('[data-outcome="denied"]')?.textContent ?? 'missing';

const PEOPLE = [
  { business: 'alpha', own: 'acme-dental', other: 'zenith-plumbing', otherBusiness: 'bravo' },
  { business: 'bravo', own: 'zenith-plumbing', other: 'acme-dental', otherBusiness: 'alpha' },
] as const;

describe('MP-2-1 isolation', () => {
  it.each(PEOPLE)(
    '$business opens its own client and is refused the other, naming nothing',
    async ({ business, own, other, otherBusiness }) => {
      expect(scoped.length).toBeGreaterThan(40);
      for (const page of scoped) {
        const mine = await open(filled(page.path, own), { businessKey: business });
        expect(mine.view.find('[data-outcome="placeholder"]'), page.path).not.toBeNull();
        await mine.view.unmount();

        const theirs = await open(filled(page.path, other), { businessKey: business });
        const refusal = theirs.view.find('[data-outcome="denied"]');
        expect(refusal, page.path).not.toBeNull();
        expect(theirs.view.find('[data-outcome="placeholder"]'), page.path).toBeNull();
        expect(refusal?.textContent, page.path).not.toContain(other);
        expect(refusal?.textContent, page.path).not.toContain(otherBusiness);
        // No rail, tab or title for another client's pages either.
        expect(
          theirs.view.all('a[href]').some((a) => a.getAttribute('href')?.includes(other)),
        ).toBe(false);
        await theirs.view.unmount();
      }
    },
  );

  it('refuses an unknown client exactly as it refuses a real one held by nobody here', async () => {
    const unknown = await open('/portal/no-such-client/', { businessKey: 'alpha' });
    const real = await open('/portal/zenith-plumbing/', { businessKey: 'alpha' });
    expect(refusalOf(unknown.view)).toBe(refusalOf(real.view));
    await unknown.view.unmount();
    await real.view.unmount();
  });

  it('serves a portal address only to its own client', async () => {
    const { view } = await open('/portal/acme-dental/account/connections/', {
      businessKey: 'alpha',
    });
    const links = view.all('a[href]').map((a) => a.getAttribute('href') ?? '');
    expect(links.filter((href) => href.startsWith('/portal/')).length).toBeGreaterThan(5);
    for (const href of links) {
      if (href.startsWith('/portal/')) expect(href).toMatch(/^\/portal\/acme-dental\//u);
    }
    await view.unmount();
  });

  it('holds no client by default, so every client address refuses until grants are wired', async () => {
    for (const page of scoped) {
      const { view } = await open(filled(page.path), { clientAccess: NO_CLIENT_GRANTS });
      expect(view.find('[data-outcome="denied"]'), page.path).not.toBeNull();
      await view.unmount();
    }
  });
});
