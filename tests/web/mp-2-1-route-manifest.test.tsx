// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-1, the route manifest and canonical addresses. One `describe` per line
// of the ticket's supporting checklist, named as the ticket names it. The
// mockup's route table is the fixture beside this file, so a route the
// manifest drops is a route this file finds missing.
//
// Widths: which page an address opens is decided before anything is laid out,
// so the resolution cases hold at 1480, 900 and 390 alike; each page's look at
// those widths belongs to that page's own ticket.

// Sequential on purpose: each case is one fresh load, one mounted app at a time.
// oxlint-disable no-await-in-loop

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CROSS_FACE,
  PAGES,
  SECTIONS,
  crossingDeclared,
  namespaceOf,
} from '../../apps/web/src/manifest.ts';
import { canonicalOf } from '../../apps/web/src/legacy.ts';
import { matchRoute } from '../../apps/web/src/routes.ts';
import {
  LEGACY,
  MOCKUP,
  filled,
  hrefs,
  json,
  mockupAddresses,
  normal,
  open,
  settle,
} from './mp-2-1-support.tsx';

const manifestPaths = new Set(PAGES.map((page) => normal(page.path)));

/** The addresses in `table` the manifest has no page for. */
const missingFrom = (table: typeof MOCKUP): readonly string[] =>
  mockupAddresses(table)
    .map((route) => normal(route.path))
    .filter((path) => !manifestPaths.has(path));

describe('MP-2-1 route table in manifest', () => {
  it('holds every address in the mockup route table', () => {
    expect(mockupAddresses().length).toBeGreaterThan(60);
    expect(missingFrom(MOCKUP)).toEqual([]);
  });

  it('fails when the table names an address the manifest lacks', () => {
    const extra = { ...MOCKUP, utilityRoutes: [{ path: '/clients/:client/not-in-the-manifest/' }] };
    expect(missingFrom(extra)).toEqual(['/clients/:client/not-in-the-manifest/']);
  });

  it('spells every address once', () => {
    expect(manifestPaths.size).toBe(PAGES.length);
  });
});

describe('MP-2-1 three namespaces', () => {
  it('has the Hub, the client workspace and the portal, each with its own rail', () => {
    expect(new Set(SECTIONS.map((section) => section.namespace))).toEqual(
      new Set(['agency', 'clients', 'portal']),
    );
  });

  it('keeps each address under its own prefix', () => {
    for (const page of PAGES) {
      const prefix = {
        agency: /^\/(?!clients\/:client|portal)/u,
        clients: /^\/clients\/:client\//u,
        portal: /^\/portal\/:client\//u,
      }[page.namespace];
      expect(page.path, page.id).toMatch(prefix);
      expect(namespaceOf(filled(page.path)), page.id).toBe(page.namespace);
    }
  });
});

describe('MP-2-1 one registry', () => {
  it('builds the Hub rail and the section tabs from the manifest', async () => {
    const { view } = await open('/connections/site-health/');
    // The rail leaves out a section with no designed page (R2, MP-2-10).
    const hub = SECTIONS.filter((section) => section.namespace === 'agency' && section.navigable);
    expect(view.all('.rail a[href]').map((a) => a.getAttribute('href'))).toEqual(
      hub.map((section) => section.path),
    );
    const section = hub.find((each) => each.id === 'connections');
    expect(view.all('[data-tabs] a[href]').map((a) => a.getAttribute('href'))).toEqual(
      section?.pages.map((page) => page.path),
    );
    await view.unmount();
  });

  it('builds the client workspace rail and tabs for the client in the address', async () => {
    const { view } = await open('/clients/acme-dental/workbench/calls/');
    const rail = view.all('.rail a[href]').map((a) => a.getAttribute('href'));
    const sections = SECTIONS.filter((section) => section.namespace === 'clients');
    expect(rail).toEqual(expect.arrayContaining(sections.map((s) => filled(s.path))));
    expect(view.all('[data-tabs] a[href]')).toHaveLength(14);
    expect(view.find('[data-tabs] [aria-current="page"]')?.textContent).toBe('Calls');
    await view.unmount();
  });

  it('draws no tab row for a section with one page', async () => {
    const { view } = await open('/inbox/');
    expect(view.find('[data-tabs]')).toBeNull();
    await view.unmount();
  });
});

describe('MP-2-1 hard reload', () => {
  // The shared state names the page and its ticket on the record, not in its
  // words, since MP-2-10 made it one plain "not here yet" (R2).
  it('lands every address on its page or on a placeholder naming the page and its ticket', async () => {
    for (const page of PAGES) {
      const { view } = await open(filled(page.path));
      expect(view.find('[data-outcome="not-found"]'), page.path).toBeNull();
      const built = matchRoute(filled(page.path));
      const placeholder = view.find(`[data-outcome="placeholder"][data-page="${page.id}"]`);
      if (built === null) {
        expect(placeholder, page.path).not.toBeNull();
        expect((placeholder as HTMLElement | null)?.dataset['ticket'], page.path).toBe(page.ticket);
      } else {
        expect(placeholder, page.path).toBeNull();
      }
      await view.unmount();
    }
  });

  it('sends a signed-out reload to sign-in and keeps the address', async () => {
    const { view } = await open('/clients/acme-dental/library/voice/', { businessKey: null });
    expect(view.find('#signin-email')).not.toBeNull();
    await view.unmount();
  });

  it('is served by the dev server as the application, not as a missing file', () => {
    const config = readFileSync(resolve('apps/web/vite.config.ts'), 'utf8');
    expect(config).not.toMatch(/appType:\s*'(?:mpa|custom)'/u);
  });
});

describe('MP-2-1 no legacy alias', () => {
  it('stores and generates canonical addresses only', () => {
    for (const page of PAGES) expect(page.path, page.id).not.toMatch(LEGACY);
    for (const [, , path] of CROSS_FACE) expect(path).not.toMatch(LEGACY);
  });

  it('draws no legacy link on any page', async () => {
    for (const page of PAGES) {
      const { view } = await open(filled(page.path));
      for (const href of hrefs(view)) expect(href, page.path).not.toMatch(LEGACY);
      expect(view.text(), page.path).not.toMatch(/\/(?:agency|client-portal)\//u);
      await view.unmount();
    }
  });

  it('keeps the canonical address, never the legacy one, when a session ends there', async () => {
    const ended = (() =>
      Promise.resolve(
        json({ refused: true, code: 'AUTH_UNKNOWN_LOGIN', names: [], fixes: [] }, 401),
      )) as unknown as typeof fetch;
    const { view, held } = await open('/agency/projects/', { fetch: ended });
    await settle();
    await view.unmount();
    const kept = held.get('ops-astro.return-to');
    expect(kept).toBeDefined();
    expect(JSON.parse(kept ?? '{}')).toMatchObject({ address: '/projects/' });
  });

  it('keeps no legacy address in the application source outside the route table', () => {
    for (const file of ['App.tsx', 'routes.ts', 'panels.ts', 'screen-registry.tsx', 'main.tsx']) {
      // Comments may cite the mockup's addresses; code may not spell one.
      const code = readFileSync(resolve('apps/web/src', file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
        .join('\n');
      expect(code, file).not.toMatch(/['"`]\/(?:agency|client-portal)\//u);
    }
  });
});

describe('MP-2-1 cross-face links', () => {
  it('declares a reason for every crossing', () => {
    for (const [from, to, , reason] of CROSS_FACE) {
      expect(from).not.toBe(to);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('draws no link to another face that the manifest does not declare', async () => {
    for (const page of PAGES) {
      const { view } = await open(filled(page.path));
      for (const href of hrefs(view)) {
        expect(crossingDeclared(page.namespace, href), `${page.path} -> ${href}`).toBe(true);
      }
      await view.unmount();
    }
  });

  it('refuses an undeclared crossing', () => {
    expect(crossingDeclared('portal', '/settings/')).toBe(false);
    expect(crossingDeclared('portal', '/clients/acme-dental/')).toBe(false);
    expect(crossingDeclared('agency', '/portal/acme-dental/')).toBe(false);
    expect(crossingDeclared('clients', '/clients/')).toBe(true);
    expect(crossingDeclared('agency', '/dashboard/')).toBe(true);
  });
});

describe('MP-2-1 task address redirect', () => {
  it('maps the mockup task address to /task/:key', () => {
    expect(canonicalOf('/agency/task/?task=TSK-7')).toBe('/task/TSK-7');
    expect(canonicalOf('/agency/task/?task=TSK%201')).toBe('/task/TSK%201');
    expect(matchRoute('/task/TSK-7')?.id).toBe('agency:task-detail');
  });

  it('redirects in the application', async () => {
    const { view, seen } = await open('/agency/task/?task=TSK-7');
    expect(seen.at(-1)).toBe('/task/TSK-7');
    await view.unmount();
  });
});
