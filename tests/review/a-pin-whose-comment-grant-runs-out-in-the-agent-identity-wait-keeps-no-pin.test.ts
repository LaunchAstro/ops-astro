// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2012), Sol's proof for S2276-2: the agent path waits on its actor's `for share` after
// the pin handler returns (`agent-standing.ts`). The delegating person's sole `review:comment`
// grant that runs out in that wait is judged again after it, so the pin is refused and keeps
// nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35pinidwait');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** ava's delegation to the fixture's agent: `review:comment` on task A alone. */
async function commentOnTaskA(): Promise<string> {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: w.ava.personId,
      mintedByActorId: w.ava.actorId,
      purpose: `pin_wait_${randomUUID().slice(0, 8)}`,
      collections: ['review'],
      actions: ['comment'],
      purposeScope: { kind: 'record', id: w.taskA },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mintDelegation refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

/** Until the pin waits on `blocker` in the actor's `for share` and the grant has run out. */
async function waitedPastExpiry(blocker: number, grantId: string): Promise<boolean> {
  for (let i = 0; i < 500; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    const [row] = await w.world.db.admin.execute<{ waiting: boolean; expired: boolean }>(
      `select exists(select 1 from pg_stat_activity
               where datname = current_database() and $1::int = any(pg_blocking_pids(pid))
                 and query like '%from public.actors where%for share%') as waiting,
              (select expires_at <= clock_timestamp() from public.grants where id = $2) as expired`,
      [blocker, grantId],
    );
    if (row?.waiting === true && row.expired) return true;
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    await pause(20);
  }
  return false;
}

/**
 * The agent actor held `for no key update` on a connection of its own, ava's sole
 * `review:comment` grant cut to four seconds, then `call` started; the hold is let go once the
 * call waits there past the expiry.
 */
async function heldThroughExpiry(call: () => Promise<CommandResult>): Promise<CommandResult> {
  const holder = connect(w.world.db.appUrl);
  let pending: Promise<CommandResult> | undefined;
  try {
    await holder.withBusiness(w.world.business, async (tx) => {
      await tx.query(
        'select id from public.actors where business_id = $1 and id = $2 for no key update',
        [tx.businessId, w.world.agentActorId],
      );
      const [blocker] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      const cut = await w.world.db.admin.execute<{ id: string }>(
        `update public.grants set expires_at = clock_timestamp() + interval '4 seconds'
          where business_id = $1 and subject_id = $2 and collection = 'review'
            and action = 'comment' and revoked_at is null returning id`,
        [w.world.business, w.ava.personId],
      );
      expect(cut, 'ava holds one review:comment grant').toHaveLength(1);
      pending = call();
      const waited = await waitedPastExpiry(blocker!.pid, cut[0]!.id);
      expect(waited, 'the pin waited on the agent actor until the grant ran out').toBe(true);
    });
    return await pending!;
  } finally {
    await pending?.catch(() => null);
    await holder.close();
  }
}

describe.skipIf(serverUrl === undefined)('C35 an agent pin after the agent identity wait', () => {
  it('a pin whose comment grant runs out while the agent actor is held is refused and keeps no pin', async () => {
    const opened = detailOf(await w.open(w.ava, { taskId: w.taskA }));
    expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('not-a-refusal');
    const credential = await commentOnTaskA();
    const pins = await w.count('pins', w.world.business);
    const answer = await heldThroughExpiry(
      async () =>
        await w.world.asAgent(
          {
            command: 'review.pin_comment',
            operationId: randomUUID(),
            revisionId: opened['revisionId'],
            width: 1480,
            selector: [spot()],
            body: 'Pinned while the grant ran out',
            audience: 'internal',
          },
          credential,
        ),
    );
    expect({
      code: codeOf(answer),
      pins: await w.count('pins', w.world.business),
    }).toStrictEqual({ code: 'DELEGATION_NARROWED', pins });
  }, 90_000);
});
