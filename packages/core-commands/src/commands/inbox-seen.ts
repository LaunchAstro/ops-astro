// SPDX-License-Identifier: AGPL-3.0-only
//
// `inbox.seen` (INB-1d): the recipient opens their own item. The stamp is their
// attention row, a preference keyed by the item and never a field on it, so
// the item stays open and counted. The key is self-scoped (`preference:write`):
// no grant is asked, and the only row it can write is the caller's own.

import { stampSeen, type TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

/** Another person's item, another business's and an unknown one get one answer. */
export async function stampOwnSeen(
  tx: TenantQuery,
  context: CommandContext,
  itemId: string,
): Promise<HandlerOutcome> {
  return (await stampSeen(tx, context.session.personId, itemId))
    ? applied(null, null, { itemId })
    : refused(refuseNotFound());
}
