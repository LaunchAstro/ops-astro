// SPDX-License-Identifier: AGPL-3.0-only
//
// What core's standing mandate check reads (MP-14-10a), locked: the client's
// row, the class's graduation row and the client's not-revoked mandates, in
// that one order. Liveness is judged on the database's clock after the lock
// wait (`mandates.ts` holds the rows' shapes and the rule that derives them).

import type { TenantQuery } from '../tenancy/database.ts';
import {
  MANDATE_COLUMNS,
  mandateOf,
  type Earned,
  type MandateDbRow,
  type MandateRow,
} from './mandates.ts';

/**
 * The not-revoked mandates of one client, share-locked: a revoke of any of
 * them waits for this transaction, and this read waits for a revoke already
 * under way, then drops the row it revoked. Whether each is live is judged in
 * a second statement, after the lock wait, so a mandate that expired while
 * this waited is not live.
 */
export async function lockClientMandates(
  tx: TenantQuery,
  clientId: string,
): Promise<readonly MandateRow[]> {
  const locked = await tx.query<{ readonly id: string }>(
    `select m.id from public.standing_mandates m
      where m.business_id = (select public.app_business_id())
        and m.client_id = $1 and m.revoked_at is null
      order by m.created_at, m.id
      for share`,
    [clientId],
  );
  if (locked.length === 0) return [];
  const rows = await tx.query<MandateDbRow>(
    `select ${MANDATE_COLUMNS} from public.standing_mandates m
      where m.business_id = (select public.app_business_id()) and m.id = any($1::uuid[])
      order by m.created_at, m.id`,
    [locked.map((row) => row.id)],
  );
  return rows.map((row) => mandateOf(row));
}

/**
 * What core's check asks about one class of one client, locked in one order:
 * the client's row for share (every mandate's insert takes it `for no key
 * update`, and the mandate writers take it first, so a refusal being filed
 * waits for this check, or this check for it), then the class's graduation
 * row for share, then the client's mandates. `earned` is null when the class
 * is not on the client's list. The guarantee is read committed's, the
 * application's level: after a wait, the next statement sees what committed.
 */
export async function lockMandateQuestion(
  tx: TenantQuery,
  clientId: string,
  actionClass: string,
): Promise<{ readonly earned: Earned | null; readonly mandates: readonly MandateRow[] }> {
  await tx.query(
    `select k.id from public.clients k
      where k.business_id = (select public.app_business_id()) and k.id = $1
      for share`,
    [clientId],
  );
  const record = await tx.query<{ readonly earned: Earned }>(
    `select g.earned from public.graduation_classes g
      where g.business_id = (select public.app_business_id())
        and g.client_id = $1 and g.action_class = $2
      for share`,
    [clientId, actionClass],
  );
  return { earned: record[0]?.earned ?? null, mandates: await lockClientMandates(tx, clientId) };
}
