// SPDX-License-Identifier: AGPL-3.0-only
//
// `budget.set_planning_cap` (AW-04, U10): the envelope asked `decide` on
// `billing` for the whole business, so only owners and administrators reach
// here, and no agent route serves it. It writes the business's `budget_caps`
// row keyed `planning` and nothing else: the key is this command's, never the
// caller's. No default is set anywhere: until a person sets one, the planning
// broker refuses every planning reply (`core-custody/src/broker-planning.ts`).
//
// **Against the limit last seen.** The cap has no revision column, so the
// caller names the limit it last saw (`fromLimitMinor`, null while unset), as
// `budget.top_up` names the maximum it saw. The row is read `for update`, the
// lock the broker takes before it holds a reply, so of two setters the loser
// waits, re-reads and is refused `VERSION_STALE` naming the limit it is at. Two
// first setters meet on the unique key instead: the second's insert waits for
// the first and does nothing.
//
// A lower cap is not refused for being below what is committed: the cap is a
// ceiling on the next reply, and the broker refuses whatever no longer fits.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { PRICE_BOOK_CURRENCY } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const positive = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 1;

const STALE_FIXES: readonly string[] = [
  'The planning cap has moved since you last saw it.',
  'Send the limit this refusal names as fromLimitMinor.',
];

interface Cap {
  readonly id: string;
  readonly limit_minor: string;
}

async function lockedCap(tx: TenantQuery): Promise<Cap | undefined> {
  const [cap] = await tx.query<Cap>(
    `select id, limit_minor::text from public.budget_caps
      where business_id = $1 and key = 'planning' for update`,
    [tx.businessId],
  );
  return cap;
}

/** Named as `settings` names its revision: the caller holds `billing:decide` here. */
const stale = (cap: Cap | undefined): HandlerOutcome =>
  refused(
    refuseCommand('VERSION_STALE', [`limitMinor=${cap?.limit_minor ?? 'unset'}`], STALE_FIXES),
  );

export async function setPlanningCap(
  tx: TenantQuery,
  _context: CommandContext,
  request: CommandRequest & { readonly command: 'budget.set_planning_cap' },
): Promise<HandlerOutcome> {
  const { limitMinor, currency, fromLimitMinor } = request;
  const invalid = [
    ...(positive(limitMinor) ? [] : ['limitMinor']),
    ...(currency === PRICE_BOOK_CURRENCY ? [] : ['currency']),
    ...(fromLimitMinor === null || positive(fromLimitMinor) ? [] : ['fromLimitMinor']),
  ];
  if (invalid.length > 0) {
    const fix = `Send whole minor units above zero, in ${PRICE_BOOK_CURRENCY}, the price book's currency.`;
    return refused(refuseCommand('FIELD_VALUE_INVALID', invalid, [fix]));
  }
  const cap = await lockedCap(tx);
  if ((cap === undefined ? null : Number(cap.limit_minor)) !== fromLimitMinor) return stale(cap);
  let id = cap?.id;
  if (id === undefined) {
    const [inserted] = await tx.query<{ id: string }>(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'planning', $3, $4)
       on conflict (business_id, key) do nothing
       returning id`,
      [tx.businessId, randomUUID(), limitMinor, currency],
    );
    // Another first setter committed the row while this insert waited on it.
    if (inserted === undefined) return stale(await lockedCap(tx));
    id = inserted.id;
  } else {
    await tx.query(
      `update public.budget_caps set limit_minor = $3
        where business_id = $1 and id = $2 and key = 'planning'`,
      [tx.businessId, id, limitMinor],
    );
  }
  return applied(id, null, { key: 'planning', limitMinor, currency });
}
