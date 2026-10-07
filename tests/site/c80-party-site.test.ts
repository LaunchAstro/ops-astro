// SPDX-License-Identifier: AGPL-3.0-only
//
// #989 criterion 2: a party's site is the one place that maps a party to its
// pages and their source files. A correction binds to its providers only
// through its own party's site, and only on a page and source file that site
// holds, spelt exactly. Two clients, each with a site: a correction of one
// naming the other's page or file binds to neither.

import { describe, expect, it } from 'vitest';
import { siteBindingFor, type PartySite } from '../../packages/core-connectors/src/index.ts';
import {
  AFTER,
  BEFORE,
  DIGEST,
  HEAD,
  PAGE,
  PROJECT,
  REPOSITORY,
  SEAM,
} from './c80-site-provider.ts';

const PARTY_A = '0b8d6f2e-1c4a-4e7b-9a3d-5f6e7d8c9b0a';
const PARTY_B = '7e1c3a5b-9d2f-4c6e-8b0a-1f3e5d7c9a2b';
const ABOUT = 'src/pages/about.md';
const B_PAGE = 'https://client-b.example/team/';
const B_FILE = 'src/pages/team.md';

const siteA: PartySite = {
  partyId: PARTY_A,
  repository: REPOSITORY,
  defaultBranch: 'main',
  project: PROJECT,
  pages: [{ pageUrl: PAGE, path: ABOUT }],
};
const siteB: PartySite = {
  partyId: PARTY_B,
  repository: 'client-b/site',
  defaultBranch: 'main',
  project: 'prj_client_b',
  pages: [{ pageUrl: B_PAGE, path: B_FILE }],
};

const correction = (over: { partyId?: string; pageUrl?: string; targetPath?: string } = {}) => ({
  partyId: PARTY_A,
  pageUrl: PAGE,
  targetPath: ABOUT,
  seam: SEAM,
  ...over,
});
const proposal = { request: '17', head: HEAD, versionDigest: DIGEST };
const change = { before: BEFORE, after: AFTER };

const bind = (site: PartySite, over: Parameters<typeof correction>[0] = {}) =>
  siteBindingFor(site, correction(over), { proposal, change });

describe("C80 a correction binds only through its own party's site", () => {
  it("binds a correction on its party's page and file, with the site's own providers", () => {
    expect(bind(siteA)).toEqual({
      ok: true,
      binding: {
        partyId: PARTY_A,
        repository: REPOSITORY,
        path: ABOUT,
        defaultBranch: 'main',
        project: PROJECT,
        pageUrl: PAGE,
        proposal: { branch: SEAM, ...proposal },
        change,
      },
    });
  });

  it("refuses a correction of party A naming party B's page and file, on either site", () => {
    const crossing = { pageUrl: B_PAGE, targetPath: B_FILE };
    expect(bind(siteA, crossing)).toEqual({ ok: false, code: 'PAGE_OUTSIDE_PARTY_SITE' });
    expect(bind(siteB, crossing)).toEqual({ ok: false, code: 'PARTY_SITE_MISMATCH' });
  });

  it("refuses party A's page with party B's file, and B's page with A's file", () => {
    expect(bind(siteA, { targetPath: B_FILE })).toEqual({
      ok: false,
      code: 'PAGE_OUTSIDE_PARTY_SITE',
    });
    expect(bind(siteA, { pageUrl: B_PAGE })).toEqual({
      ok: false,
      code: 'PAGE_OUTSIDE_PARTY_SITE',
    });
  });
});

describe('C80 a party site holds its pages spelt exactly', () => {
  it('refuses any other spelling of a page or file the site holds', () => {
    for (const pageUrl of [
      'https://agency.example/about',
      'https://AGENCY.example/about/',
      'https://agency.example/about/?x=1',
      'https://agency.example/./about/',
      'http://agency.example/about/',
    ]) {
      expect(bind(siteA, { pageUrl })).toEqual({ ok: false, code: 'PAGE_OUTSIDE_PARTY_SITE' });
    }
    for (const targetPath of [
      './src/pages/about.md',
      'src/pages//about.md',
      'SRC/pages/about.md',
    ]) {
      expect(bind(siteA, { targetPath })).toEqual({ ok: false, code: 'PAGE_OUTSIDE_PARTY_SITE' });
    }
  });
});
