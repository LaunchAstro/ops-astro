// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2121), Sol's proof on the re-cut: the agent path waits on its actor's `for share` after
// the claim or land handler returns (`agent-standing.ts`). A lease that runs out in that wait is
// judged again after it, so the claim takes no width and the land keeps no picture.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { c35World, pickUpReviewed, underReview, type C35World, type Lease } from './c35-world.ts';
import { capturesOf, claimUnder, landUnder, pictureBytes, storedObjects } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35idwait');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** Until the call waits on `blocker` in the actor's `for share` and the lease has run out. */
async function waitedPastExpiry(blocker: number, lease: Lease): Promise<boolean> {
  for (let i = 0; i < 500; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    const [row] = await w.world.db.admin.execute<{ waiting: boolean; expired: boolean }>(
      `select exists(select 1 from pg_stat_activity
               where datname = current_database() and $1::int = any(pg_blocking_pids(pid))
                 and query like '%from public.actors where%for share%') as waiting,
              (select expires_at <= clock_timestamp() from public.leases where id = $2) as expired`,
      [blocker, lease.leaseId],
    );
    if (row?.waiting === true && row.expired) return true;
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    await pause(20);
  }
  return false;
}

/**
 * The lease's actor held `for no key update` on a connection of its own, the lease cut to four
 * seconds, then `call` started; the hold is let go once the call waits there past the expiry.
 */
async function heldThroughExpiry(
  lease: Lease,
  call: () => Promise<CommandResult>,
): Promise<CommandResult> {
  const holder = connect(w.world.db.appUrl);
  let pending: Promise<CommandResult> | undefined;
  try {
    await holder.withBusiness(w.world.business, async (tx) => {
      await tx.query(
        `select a.id from public.actors a join public.leases l
            on l.business_id = a.business_id and l.holder_actor_id = a.id
          where a.business_id = $1 and l.id = $2 for no key update of a`,
        [tx.businessId, lease.leaseId],
      );
      const [blocker] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      await w.world.db.admin.execute(
        "update public.leases set expires_at = clock_timestamp() + interval '4 seconds' where id = $1",
        [lease.leaseId],
      );
      pending = call();
      const waited = await waitedPastExpiry(blocker!.pid, lease);
      expect(waited, 'the call waited on the agent actor until its lease ran out').toBe(true);
    });
    return await pending!;
  } finally {
    await pending?.catch(() => null);
    await holder.close();
  }
}

describe.skipIf(serverUrl === undefined)('C35 a worker call after the agent identity wait', () => {
  it('a claim whose lease runs out while the agent actor is held takes no width', async () => {
    const reviewed = await underReview(w, 'Claim held past its lease');
    const lease = await pickUpReviewed(w, reviewed);
    const before = await capturesOf(w, reviewed.revisionId);
    const answer = await heldThroughExpiry(
      lease,
      async () => await claimUnder(w, lease, reviewed.revisionId),
    );
    expect({
      code: codeOf(answer),
      captures: await capturesOf(w, reviewed.revisionId),
    }).toStrictEqual({ code: 'LEASE_EXPIRED', captures: before });
  }, 60_000);

  it('a land whose lease runs out while the agent actor is held stores nothing', async () => {
    const reviewed = await underReview(w, 'Land held past its lease');
    const lease = await pickUpReviewed(w, reviewed);
    expect(codeOf(await claimUnder(w, lease, reviewed.revisionId))).toBe('not-a-refusal');
    const before = {
      captures: await capturesOf(w, reviewed.revisionId),
      stored: await storedObjects(w, w.world.business),
    };
    const answer = await heldThroughExpiry(
      lease,
      async () =>
        (
          await landUnder(w, lease, {
            revisionId: reviewed.revisionId,
            width: 1480,
            picture: pictureBytes(7),
          })
        ).result,
    );
    expect({
      code: codeOf(answer),
      captures: await capturesOf(w, reviewed.revisionId),
      stored: await storedObjects(w, w.world.business),
    }).toStrictEqual({ code: 'LEASE_EXPIRED', ...before });
  }, 60_000);
});
