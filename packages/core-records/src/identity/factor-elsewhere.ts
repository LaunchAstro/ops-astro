// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a provider subject is live in a business other than this one (C59,
// ORCH65-Q3), asked inside the serving transaction. The provider holds one set
// of factors per sign-in login, so clearing a factor that login holds would
// clear it in every business it reaches; a reset is refused while another
// business holds the login live. The meaning is C58's `loginLiveElsewhere`
// (`shared-login.ts`), answered by a definer function in 0100 that sees past
// the tenant and says yes or no alone: no business, person or count.

import type { TenantQuery } from '../tenancy/database.ts';

/** Anything but a plain no is a yes, so a reset is refused on doubt. */
export async function factorLoginLiveElsewhere(tx: TenantQuery, subject: string): Promise<boolean> {
  const rows = await tx.query<{ readonly live: boolean | null }>(
    'select public.factor_login_live_elsewhere($1) as live',
    [subject],
  );
  return rows[0]?.live !== false;
}
