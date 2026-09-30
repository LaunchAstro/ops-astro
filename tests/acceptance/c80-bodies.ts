// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's bodies for the matrix and the identifier suites: the one-word request,
// and a correction another member requested, written through the records
// module so a positive approval has someone else's request to approve.

import { randomUUID } from 'node:crypto';
import { insertLiveCorrection } from '../../packages/core-records/src/site/live-corrections.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';

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

/** The matrix's positive bodies for C80's three commands (`role-case-positive-body.ts`). */
export async function c80PositiveBody(name: CommandName, context: BodyContext): Promise<Prepared> {
  if (name === 'settings.set_live_correction_approver') {
    return { body: { value: context.assigneePersonId } };
  }
  if (name === 'live_correction.request') {
    const task = await context.freshTask('a task a live correction is worked under');
    return { body: { ...C80_REQUEST, partyId: randomUUID(), taskId: task.id } };
  }
  // Another member's request, and the admin named as the approver just
  // before: the requester never approves, and only the configured one does.
  if (context.seedCorrection === undefined || context.adminPersonId === undefined) {
    return { exception: 'this harness seeds no live correction (C80)' };
  }
  const correction = await context.seedCorrection();
  const named = await context.asPerson('settings.set_live_correction_approver', {
    value: context.adminPersonId,
  });
  if (named.code !== 'ok') throw new Error(`matrix: approver refused ${named.code}`);
  return { body: { ...correction, decision: 'approve' } };
}

/** D06's positive agent body for C80's request: the picked-up task, a party of its own. */
export const c80AgentBody = (
  operationId: string,
  held: { readonly taskId: string; readonly credential: string },
): { body: Record<string, unknown>; credential: string } => ({
  body: { operationId, ...C80_REQUEST, partyId: randomUUID(), taskId: held.taskId },
  credential: held.credential,
});
