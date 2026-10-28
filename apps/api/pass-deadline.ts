// SPDX-License-Identifier: AGPL-3.0-only
//
// One deadline for a whole reconciliation pass (#2240, #1411). The function's
// request waits the pass out, so the pass, not the request, holds the bound.
// Every transaction the pass opens ends by its deadline: each business key's
// lookup and each phase of each business. None begins once it has passed,
// and the statement running at it is cancelled, so that transaction rolls back
// before the pass ends (`core-records/src/tenancy/deadline.ts`).

import type { AdminConnection, Database } from '../../packages/core-records/src/index.ts';
import { createBusinessResolver } from './server.ts';

/** The pass's view of its connection and of the lookup login, every transaction on them ending by `deadline`. */
export function passUntil(
  deadline: number,
  database: Database,
  lookup: AdminConnection,
): {
  readonly database: Database;
  readonly resolveBusiness: (businessKey: string) => Promise<string | undefined>;
} {
  return {
    database: {
      ...database,
      withBusiness: async (businessId, run) =>
        await database.withBusiness(businessId, run, { deadline }),
    },
    resolveBusiness: createBusinessResolver({
      ...lookup,
      transaction: async (body, options) =>
        await lookup.transaction(body, { ...options, deadline }),
    }),
  };
}
