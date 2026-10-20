// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator step that binds agencyastro.com's About page to Agency Astro
// (scripts/ops/bind-own-site.ts), run against a fresh local database only. It
// binds the business's own site (no client) with its repository, branch,
// Vercel project and host, writes the About page row, prints the stored
// revision and the capture pool's agency-pages entry, and a second run
// changes nothing. The page address is stored exactly as written: any other
// spelling of it is refused, with nothing written.

import { describe, expect, it } from 'vitest';
import { checkPageAllowed } from '../../packages/core-connectors/src/index.ts';
import { AGENCY_ASTRO_SITE, runBindOwnSite } from '../../scripts/ops/bind-own-site.ts';
import {
  allSites,
  ownSiteHooks,
  ownSiteOf,
  printedRevision,
  recordsIn,
  serverUrl,
  signedIn,
  subjects,
  type OwnSiteWorld,
} from './own-site-bind-step.fixture.ts';

const ABOUT = 'https://agencyastro.com/about';

let w: OwnSiteWorld;
ownSiteHooks((world) => {
  w = world;
});

const run = async (site = AGENCY_ASTRO_SITE) =>
  await runBindOwnSite(await signedIn(w, subjects.operator, 'agency'), site);

describe.skipIf(serverUrl === undefined)('the About page spelt any other way', () => {
  it.each([
    ['a trailing slash', 'https://agencyastro.com/about/'],
    ['a capital in the host', 'https://AgencyAstro.com/about'],
    ['a capital in the path', 'https://agencyastro.com/About'],
    ['a query', 'https://agencyastro.com/about?from=menu'],
    ['an empty query', 'https://agencyastro.com/about?'],
    ['a fragment', 'https://agencyastro.com/about#top'],
    ['plain http', 'http://agencyastro.com/about'],
    ['a named port', 'https://agencyastro.com:443/about'],
    ['another host', 'https://www.agencyastro.com/about'],
  ])('refuses the About page spelt with %s, writing nothing', async (_name, pageUrl) => {
    const before = await allSites(w);
    const ran = await run({
      ...AGENCY_ASTRO_SITE,
      pages: [{ pageUrl, path: 'src/pages/about.astro' }],
    });
    expect(ran.status).toBe(1);
    expect(ran.lines.join('\n')).toMatch(/REFUSED/u);
    expect(await allSites(w)).toEqual(before);
    expect(recordsIn(w)).toEqual([]);
  });
});

describe.skipIf(serverUrl === undefined)('the agency About binding step', () => {
  it('binds the agency site to the business itself, with the About page and its file', async () => {
    const ran = await run();
    expect(ran.status, ran.lines.join('\n')).toBe(0);
    const { site, pages } = await ownSiteOf(w, w.agency);
    expect(site).toMatchObject({
      party_id: null,
      repository: 'launchastro/agency-astro-astro',
      default_branch: 'main',
      project: 'prj_ZP8jeokQCN6SJsyuzkz4ISihdlHm',
      changed_by_actor_id: w.operatorActor,
    });
    expect(pages).toEqual([{ page_url: ABOUT, path: 'src/pages/about.astro' }]);
    expect(new URL(pages[0]?.page_url ?? '').host).toBe('agencyastro.com');
    expect(ran.lines.join('\n')).toContain('host agencyastro.com');
  });

  it('prints the stored revision and records it for the production record', async () => {
    const ran = await run();
    const { site } = await ownSiteOf(w, w.agency);
    expect(printedRevision(ran.lines)).toBe(site?.['revision']);
    expect(recordsIn(w).at(-1)).toMatchObject({
      act: 'own-site.bind',
      repository: 'launchastro/agency-astro-astro',
      page: ABOUT,
      revision: site?.['revision'],
      business: 'agency',
    });
  });

  it('changes nothing on a second run, and prints the same revision', async () => {
    const first = await run();
    const before = await allSites(w);
    const second = await run();
    expect(second.status, second.lines.join('\n')).toBe(0);
    expect(await allSites(w)).toEqual(before);
    expect(printedRevision(second.lines)).toBe(printedRevision(first.lines));
    expect(second.lines.join('\n')).toMatch(/unchanged/u);
  });
});

describe.skipIf(serverUrl === undefined)('what the agency About binding step prints', () => {
  it("names the capture pool's agency-pages entry, exactly the stored page, which the fence admits", async () => {
    const ran = await run();
    const { pages } = await ownSiteOf(w, w.agency);
    const entry = /agencyPages entry "([^"]+)"/u.exec(ran.lines.join('\n'))?.[1];
    expect(entry).toBe(ABOUT);
    expect(entry).toBe(pages[0]?.page_url);
    const pool = { agencyPages: [ABOUT], otherPages: [], closedPoolReviews: [] };
    expect(checkPageAllowed(ABOUT, pool).ok).toBe(true);
    expect(checkPageAllowed(`${ABOUT}/`, pool).ok).toBe(false);
  });

  it('prints no credential and no database address', async () => {
    const env = await signedIn(w, subjects.operator, 'agency');
    const said = (await runBindOwnSite(env)).lines.join('\n');
    for (const name of ['OPS_ASTRO_TOKEN', 'DATABASE_URL', 'DATABASE_ADMIN_URL'] as const) {
      expect(said).not.toContain(env[name]);
    }
  });
});
