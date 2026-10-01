// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T: the provider login an invitation's accept makes or binds, by its id
// (`invitation-accept.ts` and `invitation-bind.ts` take its lock).

import { createHash } from 'node:crypto';
import type { Database, TenantQuery } from '../../../core-records/src/index.ts';

/** The provider the `logins` rows name for Supabase Auth (`apps/api/auth/supabase.ts`). */
export const LOGIN_PROVIDER = 'supabase';

/**
 * The provider user id for one address in one business: a UUID (version 8,
 * RFC 9562) from SHA-256 of a fixed label, the business and the address. The
 * address, not the person: each invitation makes a new person, and a login an
 * earlier invitation stranded must be found by the next one for the address.
 */
export function loginSubject(business: string, address: string): string {
  const hex = createHash('sha256').update(`ops-astro login|${business}|${address}`).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Whether the transaction's business has bound a login under the subject already. */
export async function boundHere(tx: TenantQuery, subject: string): Promise<boolean> {
  const rows = await tx.query(
    'select 1 from logins where business_id = $1 and provider = $2 and subject = $3',
    [tx.businessId, LOGIN_PROVIDER, subject],
  );
  return rows.length > 0;
}

/** Whether any of the businesses has bound a login under the subject, each under its own tenancy. */
export async function loginBound(
  database: Database,
  businesses: readonly string[],
  subject: string,
): Promise<boolean> {
  let bound = false;
  for (const business of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business at a time, every one of them
    bound ||= await database.withBusiness(business, async (tx) => await boundHere(tx, subject));
  }
  return bound;
}
