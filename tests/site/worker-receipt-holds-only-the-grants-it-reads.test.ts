// SPDX-License-Identifier: AGPL-3.0-only
//
// The grants a worker's receipt holds are exactly the ones its check reads:
// a grant issued after the hold does not carry the receipt, and a grant the
// check never reads (another record's) is not held, and none is held while
// the worker still waits on the correction, as on the covered path.
import { expect, it } from 'vitest';
import postgres from 'postgres';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  checkDelegatedAuthority,
  resolveLiveById,
} from '../../packages/core-records/src/authority/delegations.ts';
import {
  recordObservedResult,
  type ObservedResult,
} from '../../packages/core-records/src/site/index.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { awaitParked, barrier, racer } from '../runtime/schedules-harness.ts';
import {
  describeWorld,
  filed,
  inBusiness,
  lows,
  stateOf,
  countOf,
  RECEIPTS,
} from './live-correction-lows.ts';

type Database = ReturnType<typeof racer>;

/** A revocation by another connection that gives up after 250 ms; true when it committed. */
async function revokeElsewhere(revoker: Database, grantId: string): Promise<boolean> {
  try {
    return await revoker.withBusiness(lows().s.business, async (other) => {
      await other.query("set local lock_timeout = '250ms'");
      await revokeGrant(other, grantId);
      return true;
    });
  } catch (error) {
    if (!(error instanceof postgres.PostgresError) || error.code !== '55P03') throw error;
    return false;
  }
}

/** The worker's live publish receipt, with `onQuery` run before each of its statements. */
async function recordLive(
  id: string,
  onQuery: (sql: string) => Promise<void>,
): Promise<{ readonly ok: boolean }> {
  const { s, leaseId, fence } = lows();
  const result: ObservedResult = {
    correctionId: id,
    leaseId,
    fence,
    actorId: s.agentActorId,
    step: 'publish',
    outcome: 'live',
    observations: { seen: 'live' },
  };
  return await inBusiness(async (tx) => {
    const scheduled: TenantQuery = {
      businessId: tx.businessId,
      async query<Row>(sql: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
        await onQuery(sql);
        return await tx.query<Row>(sql, parameters);
      },
    };
    return await recordObservedResult(scheduled, result);
  });
}

/** The run:write grants the worker's delegation stands on, as its check answers them. */
async function personRunWrites(): Promise<readonly string[]> {
  const { s, leaseId, taskA } = lows();
  const [lease] = await s.db.admin.execute<{ delegation_id: string }>(
    'select delegation_id from public.leases where id = $1',
    [leaseId],
  );
  const delegation = await inBusiness(
    async (tx) => await resolveLiveById(tx, s.agentActorId, String(lease?.delegation_id)),
  );
  if (delegation === undefined) throw new Error('missing delegation');
  const standing = await inBusiness(
    async (tx) =>
      await checkDelegatedAuthority(tx, delegation, {
        collection: 'run',
        action: 'write',
        scope: { kind: 'record', id: taskA },
      }),
  );
  if (!standing.ok) throw new Error('control lacks authority');
  return standing.value;
}

describeWorld('a worker receipt and a grant issued after its hold', 'workerheld', () => {
  it('a grant issued after the hold and revoked before the write does not carry the receipt', async () => {
    const { s } = lows();
    const { id } = await filed('approved');
    const standing = await personRunWrites();
    const revoker = racer(s);
    let issued: string | undefined;
    let revoked = false;
    try {
      for (const grantId of standing) {
        // Sequential: one connection.
        // oxlint-disable-next-line no-await-in-loop
        expect(await revokeElsewhere(revoker, grantId)).toBe(true);
      }
      const result = await recordLive(id, async (sql) => {
        if (issued === undefined && /for share of l/u.test(sql)) {
          issued = await revoker.withBusiness(
            s.business,
            async (other) => await grantTo(other, s.decider, 'write', WHOLE_BUSINESS, false, 'run'),
          );
        }
        if (issued !== undefined && /update public\.live_corrections/u.test(sql))
          revoked = await revokeElsewhere(revoker, issued);
      });
      expect(issued).toBeDefined();
      expect({
        revoked,
        writeOk: result.ok,
        state: await stateOf(id),
        receipts: await countOf(RECEIPTS, id),
      }).not.toStrictEqual({ revoked: true, writeOk: true, state: 'live', receipts: 1 });
    } finally {
      await revoker.close();
    }
  });
});

describeWorld('a worker receipt and a grant on another record', 'workerscope', () => {
  it('a grant on another record is not held by the receipt and revokes at once', async () => {
    const { s, taskB } = lows();
    const { id } = await filed('approved');
    const elsewhere = await inBusiness(
      async (tx) =>
        await grantTo(tx, s.decider, 'write', { kind: 'record', id: taskB }, false, 'run'),
    );
    const revoker = racer(s);
    let revoked: boolean | undefined;
    try {
      const result = await recordLive(id, async (sql) => {
        if (/update public\.live_corrections/u.test(sql))
          revoked = await revokeElsewhere(revoker, elsewhere);
      });
      expect({
        revoked,
        writeOk: result.ok,
        state: await stateOf(id),
        receipts: await countOf(RECEIPTS, id),
      }).toStrictEqual({ revoked: true, writeOk: true, state: 'live', receipts: 1 });
    } finally {
      await revoker.close();
    }
  });
});

describeWorld('a worker receipt waiting on the correction', 'workerwaits', () => {
  it('a revocation is not held up by a worker still waiting on the correction', async () => {
    const { s } = lows();
    const { id } = await filed('approved');
    const standing = await personRunWrites();
    const [holder, revoker] = [racer(s), racer(s)];
    const [locked, release] = [barrier(), barrier()];
    const revoked: boolean[] = [];
    try {
      const holding = holder.withBusiness(s.business, async (tx) => {
        await tx.query(
          'select 1 from public.live_corrections where business_id = $1 and id = $2 for update',
          [s.business, id],
        );
        locked.release();
        await release.held;
      });
      await locked.held;
      const writing = recordLive(id, async () => {});
      await awaitParked(s, 'live_corrections', 1);
      for (const grantId of standing) {
        // Sequential: one connection.
        // oxlint-disable-next-line no-await-in-loop
        revoked.push(await revokeElsewhere(revoker, grantId));
      }
      release.release();
      await holding;
      const result = await writing;
      expect({ revoked, writeOk: result.ok, receipts: await countOf(RECEIPTS, id) }).toStrictEqual({
        revoked: standing.map(() => true),
        writeOk: false,
        receipts: 0,
      });
    } finally {
      release.release();
      await Promise.all([holder.close(), revoker.close()]);
    }
  });
});
