// SPDX-License-Identifier: AGPL-3.0-only
//
// C33's two writes hold the authority that admitted them through commit. The
// envelope asked the declaration's key before the handler ran; a revocation
// committed after that check and before the write's own rows would otherwise
// leave a write applied after its grant was gone.

import { subjectsOf } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import {
  checkAuthorityAt,
  holdCoveringGrants,
  lockedInstant,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

/**
 * The declaration's own key over the business, asked again with the caller's
 * grants in its collection held for share, before any automation row (grants
 * before records, as `task.decide` holds them): a revocation that committed
 * first is seen here, and one that comes second waits for this transaction.
 * Asked at the clock after the hold, so a grant that lapsed while this waited
 * no longer counts. Nothing when it still holds, or the refusal.
 */
export async function holdAutomationAuthority(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome | null> {
  await holdCoveringGrants(tx, subjectsOf(context.session), context.declaration.collection);
  return await askAutomationAuthority(tx, context);
}

/**
 * The declaration's own key over the business at the clock now, holding
 * nothing new: for a write whose grants are already held, after a later wait.
 */
export async function askAutomationAuthority(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome | null> {
  const { collection, action } = context.declaration;
  const current = await checkAuthorityAt(
    tx,
    subjectsOf(context.session),
    { collection, action, scope: { kind: 'business', id: null } },
    await lockedInstant(tx),
  );
  return current.ok ? null : refused(current.refusal);
}
