// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- the review's proof, its body kept as written */
import { expect, it } from 'vitest';
import postgres from 'postgres';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  checkDelegatedAuthority,
  resolveLiveById,
} from '../../packages/core-records/src/authority/delegations.ts';
import { recordObservedResult } from '../../packages/core-records/src/site/index.ts';
import { racer } from '../runtime/schedules-harness.ts';
import {
  describeWorld,
  filed,
  inBusiness,
  lows,
  stateOf,
  countOf,
  RECEIPTS,
} from './live-correction-lows.ts';

describeWorld('a worker receipt and a concurrent grant revocation', 'workerrevoke', () => {
  it('person to person revocation cannot commit between worker authority check and receipt write', async () => {
    const { s, leaseId, fence, taskA } = lows();
    const { id } = await filed('approved');
    const [lease] = await s.db.admin.execute<{ delegation_id: string }>(
      'select delegation_id from public.leases where id = $1',
      [leaseId],
    );
    if (lease === undefined) throw new Error('missing lease');
    const delegation = await inBusiness(
      async (tx) => await resolveLiveById(tx, s.agentActorId, lease.delegation_id),
    );
    if (delegation === undefined) throw new Error('missing delegation');
    const request = {
      collection: 'run',
      action: 'write' as const,
      scope: { kind: 'record' as const, id: taskA },
    };
    const standing = await inBusiness(
      async (tx) => await checkDelegatedAuthority(tx, delegation, request),
    );
    expect(standing.ok).toBe(true);
    if (!standing.ok) throw new Error('control lacks authority');
    const revoker = racer(s);
    let revoked = false;
    let reachedWrite = false;
    try {
      const result = await inBusiness(async (tx) => {
        const scheduled: TenantQuery = {
          businessId: tx.businessId,
          async query<Row>(sql: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
            if (/update public\.live_corrections/u.test(sql)) {
              reachedWrite = true;
              try {
                revoked = await revoker.withBusiness(s.business, async (other) => {
                  await other.query("set local lock_timeout = '250ms'");
                  for (const grantId of standing.value) {
                    // oxlint-disable-next-line no-await-in-loop
                    await revokeGrant(other, grantId);
                  }
                  return true;
                });
              } catch (error) {
                if (!(error instanceof postgres.PostgresError) || error.code !== '55P03')
                  throw error;
              }
              if (revoked) {
                expect(
                  await revoker.withBusiness(
                    s.business,
                    async (other) => await checkDelegatedAuthority(other, delegation, request),
                  ),
                ).toMatchObject({ ok: false, refusal: { code: 'DELEGATION_NARROWED' } });
              }
            }
            return await tx.query<Row>(sql, parameters);
          },
        };
        return await recordObservedResult(scheduled, {
          correctionId: id,
          leaseId,
          fence,
          actorId: s.agentActorId,
          step: 'publish',
          outcome: 'live',
          observations: { seen: 'live' },
        });
      });
      expect(reachedWrite).toBe(true);
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
