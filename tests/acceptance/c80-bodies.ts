// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's bodies for the matrix and the identifier suites: the one-word request,
// and a correction another member requested, written through the records
// module so a positive approval has someone else's request to approve.

import { randomUUID } from 'node:crypto';
import { insertLiveCorrection } from '../../packages/core-records/src/site/live-corrections.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';

/** C80's one-word request, less the party and the task each recipe names. */
export const C80_REQUEST = {
  path: 'src/pages/about.md',
  word: 'friendly',
  replacement: 'welcoming',
  pageUrl: 'https://agency.example/about/',
  baseRevision: 'rev-1',
  before: 'We are a friendly studio.\n',
  after: 'We are a welcoming studio.\n',
};

/**
 * A live correction `requester` asked for, written through the records module
 * so a positive approval has another member's request to approve.
 */
export async function seedLiveCorrection(
  database: Database,
  business: string,
  taskId: string,
  requester: { readonly actorId?: string | null; readonly personId?: string | null },
): Promise<{ readonly correctionId: string; readonly versionId: string }> {
  return await database.withBusiness(business, async (tx) => {
    const stored = await insertLiveCorrection(tx, {
      ...C80_REQUEST_ROW,
      partyId: randomUUID(),
      taskId,
      requestedByActorId: requester.actorId as string,
      requestedByPersonId: requester.personId as string,
      seam: `seam-${randomUUID()}`,
    });
    return { correctionId: stored.id, versionId: stored.versionId };
  });
}

const C80_REQUEST_ROW = {
  delegationId: null,
  targetPath: C80_REQUEST.path,
  word: C80_REQUEST.word,
  replacement: C80_REQUEST.replacement,
  pageUrl: C80_REQUEST.pageUrl,
  preImageDigest: 'sha256:matrix',
  baseRevision: C80_REQUEST.baseRevision,
  versionDigest: 'sha256:matrix',
};
