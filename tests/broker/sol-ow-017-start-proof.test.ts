// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { sweepDeployment } from '../../apps/api/recovery-entry.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { grantTo } from '../commands/fixture.ts';
import { reserveModelCall, sendReservedCall } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { liveWork, racer } from '../runtime/schedules-harness.ts';
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

useBrokerWorld('solow017start');
beforeAll(async () => {
  if (noDatabase) throw new Error('Sol proof requires disposable Postgres');
  await openBilling(s);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
  });
});

it('Sol proof, criterion 5: a start whose reserved call was swept sends nothing', async () => {
  const work = await liveWork(s, `Sol swept start ${randomUUID()}`, 2_000);
  await stepOf(work);
  const request = requestFor(work);
  const reserved = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), request, broker),
  );
  if (!reserved.ok) throw new Error(`setup reserve refused ${reserved.code}`);
  await s.db.admin.execute(
    "update public.leases set expires_at = clock_timestamp() + interval '3 seconds' where id = $1",
    [work.picked['leaseId']],
  );
  let reached: (() => void) | undefined;
  let resume: (() => void) | undefined;
  const atStart = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  // Every SQL statement still reaches real Postgres. Only the scheduling of
  // the already-checked start is paused, while wall time expires its lease.
  const paused: Database = {
    ...s.db.app,
    withBusiness: async (businessId, run) =>
      await s.db.app.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async <Row>(text: string, parameters: readonly unknown[] = []) => {
              const result = await tx.query<Row>(text, parameters);
              if (text.includes('select 1 from public.copy_registrations')) {
                reached?.();
                await gate;
              }
              return result;
            },
          }),
      ),
  };
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  // A settlement error is retained so that the send count, not a rejected
  // promise or an incidental constraint, is this proof's failing assertion.
  const pending = sendReservedCall(
    paused,
    s.business,
    caller(work),
    request,
    reserved.reserved,
    broker,
  ).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  const sweep = racer(s);
  let sweepReached: (() => void) | undefined;
  let sweepResume: (() => void) | undefined;
  const atSweep = new Promise<void>((resolve) => {
    sweepReached = resolve;
  });
  const sweepGate = new Promise<void>((resolve) => {
    sweepResume = resolve;
  });
  const pausedSweep: Database = {
    ...sweep,
    withBusiness: async (businessId, run) =>
      await sweep.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async <Row>(text: string, parameters: readonly unknown[] = []) => {
              if (text.includes('update public.model_calls c') && text.includes("fault = 'ours'")) {
                sweepReached?.();
                await sweepGate;
              }
              return await tx.query<Row>(text, parameters);
            },
          }),
      ),
  };
  let sweeping: Promise<unknown> | undefined;
  try {
    await atStart;
    // The production sweep discovers no expired lease yet, so it takes no
    // lease lock. Its model-call phase later uses a fresh clock timestamp.
    sweeping = sweepDeployment(pausedSweep, () => Promise.resolve(s.business), ['home']);
    await atSweep;
    await expect
      .poll(
        async () => {
          const [lease] = await s.db.admin.execute<{ expired: boolean }>(
            'select expires_at <= clock_timestamp() as expired from public.leases where id = $1',
            [work.picked['leaseId']],
          );
          return lease?.expired;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    sweepResume?.();
    expect(await sweeping).toMatchObject({ ok: true, businesses: [{ classified: [] }] });
    expect(await calls(work)).toMatchObject([{ state: 'released' }]);
    resume?.();
    await pending;
    expect(
      world.provider.seen.length,
      'the sweep removed the unsent hold before start updated it',
    ).toBe(seen);
  } finally {
    sweepResume?.();
    await sweeping;
    resume?.();
    await pending;
    await sweep.close();
  }
});
