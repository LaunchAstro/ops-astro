// SPDX-License-Identifier: AGPL-3.0-only
//
// A client's own site for a fixture that stores corrections: one about page,
// its address and repository drawn from the client's id, so each client's site
// is its own and binding it again changes nothing.

import { bindPartySite } from '../../packages/core-records/src/index.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';

export const ABOUT_FILE = 'src/pages/about.md';

/** The about page a client's own site holds. */
export const aboutPageOf = (partyId: string): string => `https://agency.example/${partyId}/about/`;

/** Bind the client's about page, or leave it bound; the page's address. */
export async function bindAboutPage(
  tx: TransactionQuery,
  partyId: string,
  actorId: string,
): Promise<string> {
  const pageUrl = aboutPageOf(partyId);
  const bound = await bindPartySite(
    tx,
    {
      partyId,
      repository: `client/${partyId}`,
      defaultBranch: 'main',
      project: `prj_${partyId}`,
      pages: [{ pageUrl, path: ABOUT_FILE }],
    },
    actorId,
  );
  if (!bound.ok) throw new Error(`bindAboutPage: refused ${bound.code}`);
  return pageUrl;
}
