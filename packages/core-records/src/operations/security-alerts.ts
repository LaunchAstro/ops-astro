// SPDX-License-Identifier: AGPL-3.0-only
//
// The security alert log (C55, TR-SEC-9, migration 0067): each alert the
// forwarder raised, by kind and time alone. The alerts are the installation's
// and the detector counts every business's signals together, so an alert's
// time could tell one business when another's people failed a sign-in or
// exported. Only the business that operates the installation reads them;
// every other business, and every business while none operates it, reads
// none. The filter is in the query.

import type { TenantQuery } from '../tenancy/database.ts';

export interface SecurityAlert {
  readonly kind: string;
  readonly at: Date;
}

/** The newest alerts first, at most `limit`, for the operating business alone. */
export async function readSecurityAlerts(
  tx: TenantQuery,
  limit = 50,
): Promise<readonly SecurityAlert[]> {
  return await tx.query<SecurityAlert>(
    `select kind, at from ops.security_alert_log
      where exists (select 1 from ops.installation where operator_business_id = $1)
      order by at desc, kind
      limit $2`,
    [tx.businessId, limit],
  );
}
