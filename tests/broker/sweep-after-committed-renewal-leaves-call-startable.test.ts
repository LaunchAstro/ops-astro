// SPDX-License-Identifier: AGPL-3.0-only
//
// Audit proof (PR #940, criterion 5): a heartbeat admitted before its lease
// ran out commits its renewal after the sweep has locked the unsent call but
// before the sweep's release update runs. The release must see the renewal
// and leave the call reserved, so its still-authorised owner can start it.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import {
  reserveModelCall,
  sendReservedCall,
  sweepModelCalls,
} from '../../packages/core-custody/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { heartbeat } from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { liveWork, racer, rows } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import {
  broker,
  caller,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';
import { calls } from './give-back-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('auditproof940r21');

beforeAll(async () => {
  if (noDatabase) return;
  await openBilling(s);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
  });
}, 120_000);

/** A transaction that stops once at the first statement holding `marker`, until resumed. */
function pausedAt(marker: string, when: 'before' | 'after') {
  let reach: (() => void) | undefined;
  let resume: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let done = false;
  const hold = async (sql: string): Promise<void> => {
    if (done || !sql.includes(marker)) return;
    done = true;
    reach?.();
    await gate;
  };
  const wrap = (tx: TenantQuery): TenantQuery => ({
    ...tx,
    query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
      if (when === 'before') await hold(sql);
      const result = await tx.query<Row>(sql, parameters);
      if (when === 'after') await hold(sql);
      return result;
    },
  });
  return { reached, resume: () => resume?.(), wrap };
}

const leaseExpiry = async (leaseId: string) => {
  const [row] = await rows<{ expired: boolean }>(
    s,
    'select expires_at <= clock_timestamp() as expired from public.leases where id = $1',
    [leaseId],
  );
  return row?.expired;
};

it('a sweep after a committed renewal leaves the call startable', async () => {
  const work = await liveWork(s, `audit proof 940 r2.1 ${randomUUID()}`, 2_000);
  world.provider.mode('answer');
  await stepOf(work);
  const request = requestFor(work);
  const leaseId = String(work.picked['leaseId']);
  const held = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), request, broker),
  );
  if (!held.ok) throw new Error(`setup reserve refused ${held.code}`);
  await s.db.admin.execute(
    "update public.leases set expires_at = clock_timestamp() + interval '3 seconds' where id = $1",
    [leaseId],
  );

  // Connection A: the heartbeat, paused after lockOwnedLease judged the lease
  // live at its locked instant, before renew updates it.
  const a = racer(s);
  const beat = pausedAt('set expires_at = greatest(', 'before');
  const beating = a.withBusiness(
    s.business,
    async (tx) =>
      await heartbeat(beat.wrap(tx), {
        claimant: 'agent',
        leaseId,
        fence: Number(work.picked['fence']),
        holderActorId: s.agentActorId,
        delegationId: String(work.picked['delegationId']),
        renewSeconds: 60,
      }),
  );
  // Connection B: the sweep, paused once releaseUnsent's row lock returns the call.
  const b = racer(s);
  const sweep = pausedAt('for update of c skip locked', 'after');
  let sweeping: Promise<unknown> | undefined;
  try {
    const first = await Promise.race([
      beat.reached.then(() => 'paused' as const),
      beating.then((result) => result),
    ]);
    expect(first, 'the heartbeat reaches renew with the lease live').toBe('paused');
    // The original expiry passes while A holds its checked instant.
    await expect.poll(async () => await leaseExpiry(leaseId), { timeout: 5_000 }).toBe(true);

    sweeping = b.withBusiness(s.business, async (tx) => await sweepModelCalls(sweep.wrap(tx)));
    await sweep.reached;
    const [locked] = await rows<{ n: string }>(
      s,
      `select count(*)::text as n from public.model_calls where id = $1 and state = 'reserved'`,
      [held.reserved.callId],
    );
    expect(locked?.n, 'the sweep holds the reserved call').toBe('1');

    beat.resume();
    expect(await beating, 'the heartbeat renews and commits').toMatchObject({ ok: true });
    expect(await leaseExpiry(leaseId), 'the renewed lease runs on').toBe(false);

    sweep.resume();
    await sweeping;
    const [after] = await calls(work);
    const sent = await sendReservedCall(
      s.db.app,
      s.business,
      caller(work),
      request,
      held.reserved,
      broker,
    );
    expect(
      { state: after?.state, sent: sent.ok, code: sent.ok ? undefined : sent.code },
      'the release sees the committed renewal; the owner starts the call',
    ).toEqual({ state: 'reserved', sent: true, code: undefined });
  } finally {
    beat.resume();
    sweep.resume();
    await beating.catch(() => undefined);
    await sweeping?.catch(() => undefined);
    await a.close();
    await b.close();
  }
});
