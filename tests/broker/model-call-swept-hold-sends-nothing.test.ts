// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { sweepDeployment } from '../../apps/api/recovery-entry.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  reserveModelCall,
  sendReservedCall,
  type ReservedCall,
} from '../../packages/core-custody/src/index.ts';
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

/**
 * The database with one statement paused: every statement still reaches real
 * Postgres, and the first one `matches` names waits, before or after it runs,
 * until `resume`. `reached` settles when it gets there.
 */
function pausedAt(
  database: Database,
  matches: (text: string) => boolean,
  when: 'before' | 'after',
): { readonly database: Database; readonly reached: Promise<void>; readonly resume: () => void } {
  let arrive: (() => void) | undefined;
  let open: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const hold = async (text: string): Promise<void> => {
    if (!matches(text)) return;
    arrive?.();
    await gate;
  };
  return {
    reached,
    resume: () => open?.(),
    database: {
      ...database,
      withBusiness: async (businessId, run) =>
        await database.withBusiness(
          businessId,
          async (tx) =>
            await run({
              ...tx,
              query: async <Row>(text: string, parameters: readonly unknown[] = []) => {
                if (when === 'before') await hold(text);
                const result = await tx.query<Row>(text, parameters);
                if (when === 'after') await hold(text);
                return result;
              },
            }),
        ),
    },
  };
}

type Work = Awaited<ReturnType<typeof liveWork>>;

/** A committed hold on live work whose lease runs out three seconds on. */
async function heldOnExpiringLease(work: Work) {
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
  return { request, reserved };
}

/** Waits, up to five seconds, for the work's lease to have run out. */
async function leaseExpired(work: Work): Promise<void> {
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
}

/**
 * The held call's send. A settlement error is retained so that the send
 * count, not a rejected promise or an incidental constraint, is this proof's
 * failing assertion.
 */
async function sendRetained(
  database: Database,
  work: Work,
  request: ReturnType<typeof requestFor>,
  reserved: ReservedCall,
): Promise<{ readonly result: unknown } | { readonly error: unknown }> {
  return await sendReservedCall(database, s.business, caller(work), request, reserved, broker).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
}

it('a start whose reserved call was swept sends nothing', async () => {
  const work = await liveWork(s, `Sol swept start ${randomUUID()}`, 2_000);
  const { request, reserved } = await heldOnExpiringLease(work);
  // Every SQL statement still reaches real Postgres. Only the scheduling of
  // the already-checked start is paused, while wall time expires its lease.
  const start = pausedAt(
    s.db.app,
    (text) => text.includes('select 1 from public.copy_registrations'),
    'after',
  );
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  const pending = sendRetained(start.database, work, request, reserved.reserved);
  const sweep = racer(s);
  const sweepAt = pausedAt(
    sweep,
    (text) => text.includes('update public.model_calls c') && text.includes("fault = 'ours'"),
    'before',
  );
  let sweeping: Promise<unknown> | undefined;
  try {
    await start.reached;
    // The production sweep discovers no expired lease yet, so it takes no
    // lease lock. Its model-call phase later uses a fresh clock timestamp.
    sweeping = sweepDeployment(sweepAt.database, () => Promise.resolve(s.business), ['home']);
    await sweepAt.reached;
    await leaseExpired(work);
    sweepAt.resume();
    expect(await sweeping).toMatchObject({ ok: true, businesses: [{ classified: [] }] });
    expect(await calls(work)).toMatchObject([{ state: 'released' }]);
    start.resume();
    await pending;
    expect(
      world.provider.seen.length,
      'the sweep removed the unsent hold before start updated it',
    ).toBe(seen);
  } finally {
    sweepAt.resume();
    await sweeping;
    start.resume();
    await pending;
    await sweep.close();
  }
});
