// SPDX-License-Identifier: AGPL-3.0-only
//
// Two of C80's matrix bodies (`c80-bodies.ts`), apart for that file's line cap:
// the revert ask, and R5's record of Astra's review.

import type { BodyContext, Prepared } from './role-case-bodies.ts';

/** The revert ask: another member's correction recorded live, the admin named its approver. */
export async function revertBody(context: BodyContext): Promise<Prepared> {
  if (context.seedLiveCorrection === undefined || context.adminPersonId === undefined) {
    return { exception: 'this harness records no live correction (C80)' };
  }
  const { correctionId } = await context.seedLiveCorrection();
  const named = await context.asPerson('settings.set_live_correction_approver', {
    value: context.adminPersonId,
  });
  if (named.code !== 'ok') throw new Error(`matrix: approver refused ${named.code}`);
  return { body: { correctionId } };
}

/** R5: Astra's review of a seeded request's version; every seeded row pins `sha256:matrix`. */
export const reviewBody = (correctionId: string): Prepared => ({
  body: {
    correctionId,
    versionDigest: 'sha256:matrix',
    verdict: 'approve',
    review: 'Astra: fine.',
  },
});
