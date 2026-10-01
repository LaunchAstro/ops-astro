// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-1, legacy redirects: every mockup address is answered with a canonical
// one in the manifest (`legacy.ts`), and the canonical address then passes the
// same grant check as any other. Split from mp-2-1-route-manifest.test.tsx so
// each file stays under the line rule; the cases are unchanged.

import { describe, expect, it } from 'vitest';
import { canonicalOf } from '../../apps/web/src/legacy.ts';
import { pageAt } from '../../apps/web/src/manifest.ts';
import { LEGACY, filled, mockupAddresses, mockupPick, open } from './mp-2-1-support.tsx';

const known = mockupAddresses().filter(
  (route) => route.source !== undefined && LEGACY.test(route.source),
);

// One ruled exception: Portfolio Command's source goes to `/dashboard/`,
// where R1 put it, not to the separate tab the mockup had (MP-2-10).
const RULED: Readonly<Record<string, string>> = { '/agency/portfolio/': '/dashboard/' };

describe('MP-2-1 legacy redirects', () => {
  it('maps every known legacy address to a canonical one in the manifest', () => {
    expect(known.length).toBeGreaterThan(30);
    for (const route of known) {
      const legacy = `${route.source ?? ''}?client=acme-dental${route.legacyHash ?? ''}`;
      const target = canonicalOf(legacy);
      expect(target, legacy).not.toBeNull();
      expect(target, legacy).not.toMatch(LEGACY);
      expect(pageAt(target ?? '')?.page.path, legacy).toBeDefined();
    }
  });

  it('lands every known legacy address on the page the mockup itself chose for it', () => {
    for (const route of known) {
      const source = route.source ?? '';
      const hash = route.legacyHash ?? '';
      const ruled = RULED[source];
      if (ruled !== undefined) {
        expect(canonicalOf(`${source}${hash}`), source).toBe(ruled);
        continue;
      }
      const expected = mockupPick(source, hash);
      expect(expected, source).toBeDefined();
      expect(canonicalOf(`${source}?client=acme-dental${hash}`), `${source}${hash}`).toBe(
        filled(expected?.path ?? 'missing'),
      );
    }
  });
});

describe('MP-2-1 legacy redirects, address by address', () => {
  it('picks the tab a legacy hash named', () => {
    expect(canonicalOf('/client-portal/channel-workbench/?client=acme-dental#ads')).toBe(
      '/clients/acme-dental/workbench/google-ads/',
    );
    expect(canonicalOf('/client-portal/projects/?client=acme-dental#roadmap')).toBe(
      '/clients/acme-dental/projects/roadmap/',
    );
    // R1, MP-2-10: Portfolio Command sits at /dashboard/.
    expect(canonicalOf('/agency/portfolio/')).toBe('/dashboard/');
    expect(canonicalOf('/client-portal/home/?client=acme-dental')).toBe('/portal/acme-dental/');
  });

  it('sends a legacy client address with no client named to the client list', () => {
    expect(canonicalOf('/agency/brief/')).toBe('/clients/');
  });

  it('answers nothing for a canonical address or an unknown one', () => {
    expect(canonicalOf('/dashboard/portfolio/')).toBeNull();
    expect(canonicalOf('/agency/never-was/')).toBeNull();
  });

  it('redirects in the application, then applies the same grant check', async () => {
    const mine = await open('/client-portal/library/voice/?client=acme-dental');
    expect(mine.seen.at(-1)).toBe('/clients/acme-dental/library/voice/');
    expect(mine.view.find('[data-outcome="placeholder"]')).not.toBeNull();
    await mine.view.unmount();

    const theirs = await open('/client-portal/library/voice/?client=zenith-plumbing');
    expect(theirs.seen.at(-1)).toBe('/clients/zenith-plumbing/library/voice/');
    expect(theirs.view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(theirs.view.find('[data-outcome="placeholder"]')).toBeNull();
    await theirs.view.unmount();
  });
});
