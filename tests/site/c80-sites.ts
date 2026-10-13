// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's client sites for the command-layer world (`c80-world.ts`): the pages
// each client's site holds, and their binding when a world is made. A
// correction is stored only for a page its own client's site holds, so every
// request a world makes names one of these.

import { randomUUID } from 'node:crypto';
import type { AgentWorld } from '../commands/agent-fixture.ts';
import type { Member } from '../commands/fixture.ts';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';

export const ABOUT = 'src/pages/about.md';
export const PAGE = 'https://agency.example/about/';
/** Party A's page built from an Astro file. */
export const ASTRO_PAGE = 'https://agency.example/about-astro/';
export const ASTRO_FILE = 'src/pages/about.astro';
/** Party B's page and its source file: on B's site, never A's. */
export const B_PAGE = 'https://client-b.example/team/';
export const B_FILE = 'src/pages/team.md';

/**
 * Each client's site: party A holds the about page, party B its team page, and
 * beta's client the about page in its own business. A site is bound once in
 * the installation, so each world's repositories and projects are its own.
 */
export async function bindSites(
  world: AgentWorld,
  admin: Member,
  beta: { readonly beta: string; readonly eve: Member; readonly betaParty: string },
  parties: { readonly partyA: string; readonly partyB: string },
): Promise<void> {
  const own = randomUUID().slice(0, 8);
  const site = (partyId: string, name: string, ...pages: { pageUrl: string; path: string }[]) => ({
    partyId,
    repository: `${name}/site-${own}`,
    defaultBranch: 'main',
    project: `prj_${name}_${own}`,
    pages,
  });
  await world.db.app.withBusiness(world.business, async (tx) => {
    const pages = [
      { pageUrl: PAGE, path: ABOUT },
      { pageUrl: ASTRO_PAGE, path: ASTRO_FILE },
    ];
    await bindPartySite(tx, site(parties.partyA, 'agency', ...pages), admin.actorId);
    const pageB = { pageUrl: B_PAGE, path: B_FILE };
    await bindPartySite(tx, site(parties.partyB, 'client-b', pageB), admin.actorId);
  });
  await world.db.app.withBusiness(beta.beta, async (tx) => {
    const about = { pageUrl: PAGE, path: ABOUT };
    await bindPartySite(tx, site(beta.betaParty, 'beta', about), beta.eve.actorId);
  });
}
