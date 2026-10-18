// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693, with no database: the site runner acts for its one configured site
// (`SITE_RUNNER_SITE`). Every port it builds, the proposal's, the publish's and
// the locate's, refuses a call naming another repository, branch, path,
// project or page `SITE_NOT_CONFIGURED` before anything else, so a counting
// double behind custody is asked nothing. The site setting refuses a missing
// or unknown key, a holder outside the business, an inexact path and a page
// that is not https, each by naming the key, never a value. Locating only, a
// write through real custody is refused at its route and no claim is taken.
/* eslint-disable max-lines, max-lines-per-function -- the ports, the setting and locating only, each whole */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { holderRefuses } from '../../apps/site-runner/configured.ts';
import { passFor } from '../../apps/site-runner/main.ts';
import { settingsFrom } from '../../apps/site-runner/settings.ts';
import { custodySites, siteDestinations, type SitePorts } from '../../apps/site-runner/sites.ts';
import {
  callConnector,
  siteOperation,
  type SiteBinding,
} from '../../packages/core-connectors/src/index.ts';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';
import type { PartySiteRecord, TenantQuery } from '../../packages/core-records/src/index.ts';

const BUSINESS = '6f1c2a54-9d0b-4c1e-8a7f-3b2d1e0f9a8c';
const CLIENT = '0b8d6f2e-1c4a-4e7b-9a3d-5f6e7d8c9b0a';
const PAGE = 'https://agencyastro.com/about';
const PATH = 'src/pages/about.astro';
const SITE = {
  holder: BUSINESS,
  repository: 'LaunchAstro/agency-astro-astro',
  defaultBranch: 'main',
  project: 'prj_agency',
  pages: [{ pageUrl: PAGE, path: PATH }],
};
const HEAD = 'a'.repeat(40);

interface Counted {
  dispatched: number;
  resolved: number;
  captured: number;
}

/** The runner's custody-backed ports over a custody double that counts every call it is handed. */
function counted(custody?: Pick<Custody, 'dispatch'>): { ports: SitePorts; seen: Counted } {
  const seen: Counted = { dispatched: 0, resolved: 0, captured: 0 };
  const ports: SitePorts = {
    custody: custody ?? {
      dispatch: () => {
        seen.dispatched += 1;
        return Promise.resolve({ kind: 'refused', code: 'COUNTED' } as never);
      },
    },
    resolve: () => {
      seen.resolved += 1;
      return Promise.resolve(['140.82.112.6']);
    },
    capture: {
      pool: { agencyPages: [PAGE], otherPages: [], closedPoolReviews: [] },
      resolve: () => Promise.resolve(['93.184.216.34']),
      transport: () => {
        seen.captured += 1;
        return Promise.resolve({ kind: 'failed' });
      },
    },
    wait: () => Promise.resolve(),
    now: () => 1_000,
  };
  return { ports, seen };
}

const bound = (overrides: Partial<PartySiteRecord> = {}): PartySiteRecord => ({
  partyId: null,
  repository: SITE.repository,
  defaultBranch: SITE.defaultBranch,
  project: SITE.project,
  pages: SITE.pages,
  ...overrides,
});

const binding = (overrides: Partial<SiteBinding> = {}): SiteBinding => ({
  partyId: null,
  repository: SITE.repository,
  path: PATH,
  defaultBranch: 'main',
  project: SITE.project,
  pageUrl: PAGE,
  proposal: {
    branch: 'seam-5b0e2c1a-3d4f-4a6b-8c7d-9e0f1a2b3c4d',
    request: '17',
    head: HEAD,
    versionDigest: `sha256:${'cd'.repeat(32)}`,
  },
  change: { before: 'We walk alongside you.\n', after: 'We walk beside you.\n' },
  ...overrides,
});

const NOT_CONFIGURED = { kind: 'refused', code: 'SITE_NOT_CONFIGURED' };
const raise = (): Promise<void> => Promise.resolve();

describe('the site runner acts only for its configured site, at every port', () => {
  it('refuses a proposal on another repository, branch or path, asking custody nothing', async () => {
    const { ports, seen } = counted();
    const sites = custodySites(ports, SITE);
    const elsewhere = sites.propose(bound({ repository: 'someone/else' }), PATH, raise);
    expect(await elsewhere.file(HEAD)).toEqual(NOT_CONFIGURED);
    expect(await elsewhere.head()).toEqual(NOT_CONFIGURED);
    const otherBranch = sites.propose(bound({ defaultBranch: 'staging' }), PATH, raise);
    expect(await otherBranch.head()).toEqual(NOT_CONFIGURED);
    const otherPath = sites.propose(bound(), 'src/pages/team.astro', raise);
    expect(await otherPath.file(HEAD)).toEqual(NOT_CONFIGURED);
    // A write on, or a request opened onto, any branch but the default one.
    const own = sites.propose(bound(), PATH, raise);
    const write = { repository: SITE.repository, path: PATH, message: 'm', content: '', sha: HEAD };
    for (const [operation, params] of [
      ['site.publish', { ...write, branch: 'staging' }],
      ['site.source.revert', { ...write, branch: 'staging' }],
      ['site.source.head', { repository: SITE.repository, branch: 'staging' }],
      [
        'site.source.propose.request',
        { repository: SITE.repository, title: 't', head: 'seam-x', base: 'staging' },
      ],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one call after another
      expect(await callConnector(siteOperation(operation), params, own.connector)).toEqual(
        NOT_CONFIGURED,
      );
    }
    expect(seen).toEqual({ dispatched: 0, resolved: 0, captured: 0 });
  });

  it('refuses a publish on another repository, path, project or page, asking custody nothing', async () => {
    const { ports, seen } = counted();
    const sites = custodySites(ports, SITE);
    for (const foreign of [
      binding({ repository: 'someone/else' }),
      binding({ path: 'src/pages/team.astro' }),
      binding({ pageUrl: 'https://agencyastro.com/team' }),
    ]) {
      const run = sites.publish(foreign, raise);
      // oxlint-disable-next-line no-await-in-loop -- one port after another
      expect(await run.readSource()).toEqual(NOT_CONFIGURED);
      expect(run.refusals()).toEqual(['SITE_NOT_CONFIGURED']);
    }
    const otherProject = sites.publish(binding({ project: 'prj_someone' }), raise);
    // A lookup refused finds nothing; its refusal is kept for the receipt.
    await otherProject.findDeployment(HEAD);
    expect(otherProject.refusals()).toEqual(['SITE_NOT_CONFIGURED']);
    expect(seen).toEqual({ dispatched: 0, resolved: 0, captured: 0 });
  });

  it('refuses a locate read of any path but a configured page, asking custody nothing', async () => {
    const { ports, seen } = counted();
    const locate = custodySites(ports, SITE).locate();
    expect(await locate.file('src/pages/team.astro', HEAD)).toEqual(NOT_CONFIGURED);
    expect(await locate.file('src/layouts/Base.astro', HEAD)).toEqual(NOT_CONFIGURED);
    expect(seen).toEqual({ dispatched: 0, resolved: 0, captured: 0 });
    // The configured page's file, and the head, are handed to custody.
    await locate.head();
    await locate.file(PATH, HEAD);
    expect(seen.dispatched).toBe(2);
  });
});

const GOOD = {
  OPS_ASTRO_API_URL: 'https://ops.example',
  OPS_ASTRO_BUSINESS: 'agency',
  OPS_ASTRO_BUSINESS_ID: BUSINESS,
  OPS_ASTRO_EMAIL: ['site-runner', 'example.com'].join('@'),
  OPS_ASTRO_PASSWORD: 'canary-password-5c1d0e77',
  OPS_ASTRO_GOTRUE_URL: 'https://auth.example',
  SITE_RUNNER_DATABASE_URL: 'postgres://db.example:5432/postgres?sslmode=require',
  SITE_RUNNER_CREDENTIALS_FILE: '/var/empty/site-credentials.json',
};
const siteSetting = (site: Readonly<Record<string, unknown>>) =>
  settingsFrom({ ...GOOD, SITE_RUNNER_SITE: JSON.stringify(site) });
const asSet = { ...SITE, business: BUSINESS };
const without = (key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(asSet).filter(([name]) => name !== key));
const CANARY = 'canary-value-91f3';

describe('the site setting', () => {
  it('reads one site with exactly its keys, its pages the fence pages', () => {
    const settings = siteSetting(asSet);
    if (typeof settings === 'string') throw new Error(settings);
    expect(settings.site).toEqual(SITE);
    expect(settings.pages).toEqual([PAGE]);
    expect(settings.locateOnly).toBe(false);
  });

  it('refuses a missing or unknown key, an inexact path or a page not https, naming the key only', () => {
    const refusals = [
      siteSetting(without('project')),
      siteSetting({ ...asSet, [`token-${CANARY}`]: CANARY }),
      siteSetting({ ...asSet, business: CANARY }),
      siteSetting({ ...asSet, holder: CANARY }),
      siteSetting({ ...asSet, pages: [{ pageUrl: PAGE, path: `src/pages/../${CANARY}.astro` }] }),
      siteSetting({ ...asSet, pages: [{ pageUrl: PAGE, path: `src/layouts/${CANARY}.astro` }] }),
      siteSetting({ ...asSet, pages: [{ pageUrl: `http://${CANARY}.com/about`, path: PATH }] }),
      siteSetting({ ...asSet, pages: [{ pageUrl: `https://${CANARY}.com/a/../b`, path: PATH }] }),
      siteSetting({ ...asSet, pages: [{ pageUrl: PAGE, path: PATH, note: CANARY }] }),
      settingsFrom({ ...GOOD, SITE_RUNNER_PAGES: PAGE }),
    ];
    expect(refusals).toEqual([
      'SITE_RUNNER_SITE.project is missing',
      `SITE_RUNNER_SITE.token-${CANARY} is not a key the site holds`,
      'SITE_RUNNER_SITE.business is not OPS_ASTRO_BUSINESS_ID',
      'SITE_RUNNER_SITE.holder is not the business or a client id',
      'SITE_RUNNER_SITE.pages.path is not a page source under src/pages/',
      'SITE_RUNNER_SITE.pages.path is not a page source under src/pages/',
      'SITE_RUNNER_SITE.pages.pageUrl is not an exact https page',
      'SITE_RUNNER_SITE.pages.pageUrl is not an exact https page',
      'SITE_RUNNER_SITE.pages holds a page without exactly pageUrl and path',
      'missing SITE_RUNNER_SITE',
    ]);
    // The unknown key is named as it was written; no value is repeated.
    expect(
      JSON.stringify(refusals.filter((line) => !String(line).includes('token-'))),
    ).not.toContain(CANARY);
  });

  it('confirms a client holder in the business by one read, and refuses one outside it', async () => {
    const asked: unknown[][] = [];
    const tx = (rows: readonly unknown[]): TenantQuery => ({
      businessId: BUSINESS,
      query: <Row>(_text: string, parameters?: readonly unknown[]) => {
        asked.push([...(parameters ?? [])]);
        return Promise.resolve(rows as readonly Row[]);
      },
    });
    expect(await holderRefuses(tx([]), SITE)).toBeUndefined();
    expect(asked).toEqual([]);
    const client = { ...SITE, holder: CLIENT };
    expect(await holderRefuses(tx([{ id: CLIENT }]), client)).toBeUndefined();
    const outside = await holderRefuses(tx([]), client);
    expect(outside).toBe('SITE_RUNNER_SITE.holder is not the business or its client');
    expect(outside).not.toContain(CLIENT);
    expect(asked).toEqual([
      [BUSINESS, CLIENT],
      [BUSINESS, CLIENT],
    ]);
  });
});

const folder = mkdtempSync(join(tmpdir(), 'site-runner-locate-only-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('the site runner, locating only', () => {
  it('sends no write through custody, and takes no claim', async () => {
    const settings = settingsFrom({
      ...GOOD,
      SITE_RUNNER_SITE: JSON.stringify(asSet),
      SITE_RUNNER_LOCATE_ONLY: '1',
    });
    if (typeof settings === 'string') throw new Error(settings);
    expect(settings.locateOnly).toBe(true);
    const credentialsFile = join(folder, 'credentials.json');
    const entries = (['source_control', 'hosting'] as const).map((ref) => ({
      ref,
      kind: 'api_key',
      account: `${ref}-fixture`,
      destination: ref,
      header: 'authorization',
      value: `fixture-${ref}`,
    }));
    writeFileSync(credentialsFile, JSON.stringify(entries), { mode: 0o600 });
    chmodSync(credentialsFile, 0o600);
    const custody = await startCustody({
      credentialsFile,
      destinations: siteDestinations(
        // Hosts that never resolve: a write custody did route would still reach nothing.
        { source: 'https://site-source.invalid', hosting: 'https://site-hosting.invalid' },
        settings.locateOnly,
      ),
    });
    try {
      const { ports } = counted(custody);
      const own = custodySites(ports, settings.site).propose(bound(), PATH, () =>
        Promise.resolve(),
      );
      const written = await callConnector(
        siteOperation('site.publish'),
        {
          repository: SITE.repository,
          path: PATH,
          message: 'Live correction',
          content: Buffer.from('We walk beside you.\n').toString('base64'),
          sha: HEAD,
          branch: 'main',
        },
        own.connector,
      );
      expect(written).toEqual({ kind: 'refused', code: 'CUSTODY_ROUTE_REFUSED' });
    } finally {
      await custody.stop();
    }
    const parts = { locate: 0, claims: 0 };
    const pass = passFor(settings.locateOnly, {
      locate: () => {
        parts.locate += 1;
        return Promise.resolve([]);
      },
      claims: () => {
        parts.claims += 1;
        return Promise.resolve([]);
      },
    });
    await pass();
    await pass();
    expect(parts).toEqual({ locate: 2, claims: 0 });
  }, 60_000);
});
