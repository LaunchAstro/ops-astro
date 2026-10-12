// SPDX-License-Identifier: AGPL-3.0-only
//
// One tenant transaction sent through a relay that kills its connection at a
// named point (`cutProxy`): before the server sees the commit, or after it has
// committed and before the client hears so. The caller sees a dead connection
// either way; what is durable is what a crash or retry proof then reads.

import { setTimeout as delay } from 'node:timers/promises';
import {
  connect,
  type BusinessId,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { cutProxy, type CutPoint } from '../runtime/schedules-harness.ts';

/** Runs `write` in one transaction on `url` through a relay cut at `point`; answers how it settled. */
export async function cutTransaction(
  url: string,
  business: BusinessId | string,
  point: CutPoint,
  write: (tx: TenantQuery) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>> {
  const proxy = await cutProxy(url, point);
  const database = connect(proxy.url, { source: 'cut' });
  try {
    const [settled] = await Promise.allSettled([
      database.withBusiness(business as BusinessId, async (tx) => await write(tx)),
    ]);
    if (!proxy.cut()) throw new Error(`the relay never reached its ${point} point`);
    return settled as PromiseSettledResult<unknown>;
  } finally {
    // A pool whose one connection was cut may never finish ending; it is let go
    // of after a second rather than awaited for ever.
    await Promise.race([database.close().catch(() => null), delay(1_000)]);
    await proxy.close();
  }
}
