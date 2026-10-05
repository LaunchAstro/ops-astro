// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 export: two exports at once read the same batch; the faster delivers
// and advances the cursor while the slower waits on the target, then fails.
// The slower one's gap must name the cursor its batch was read after.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { exportOnce } from '../../packages/core-runtime/src/trace-export.ts';
import { liveWork, openSchedules, type Schedules } from './schedules-harness.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;
let alpha: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  alpha = await openSchedules('gapcursor', 1_000_000);
});

afterAll(async () => {
  await alpha?.db.drop();
});

/** How many of the business's events are not yet below the export's horizon. */
async function heldBack(): Promise<number> {
  const [row] = await alpha.db.app.withBusiness(
    alpha.business,
    async (tx) =>
      await tx.query<{ readonly events: number }>(
        `select count(*)::int as events from public.run_events
          where business_id = $1 and tx >= pg_snapshot_xmin(pg_current_snapshot())`,
        [alpha.business],
      ),
  );
  return row?.events ?? 0;
}

/**
 * Until every event of the business is below the export's horizon, as AW-13's
 * `exportDue` waits, but without exporting: a transaction open anywhere on the
 * cluster (another file's, in a parallel run) holds a fresh event back, and an
 * export read then finds nothing.
 */
async function untilReadable(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- until the events are due
    if ((await heldBack()) === 0) return;
    // eslint-disable-next-line no-await-in-loop -- waiting out the horizon
    await sleep(50);
  }
  throw new Error('no event became readable');
}

it('a failed concurrent export records the cursor its batch was read from', async () => {
  await liveWork(alpha, 'gap concurrency', 1_000);
  await untilReadable();
  const before = await alpha.db.app.withBusiness(
    alpha.business,
    async (tx) =>
      await tx.query(
        'select after_tx::text, after_id from public.trace_export_cursors where business_id = $1',
        [alpha.business],
      ),
  );
  expect(before).toEqual([]);
  let reached!: () => void;
  const atTarget = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = exportOnce(alpha.db.app, alpha.business, Buffer.from('proof key'), async () => {
    reached();
    await held;
    return { ok: false, fault: 'network', status: null };
  });
  try {
    await atTarget;
    const fast = await exportOnce(alpha.db.app, alpha.business, Buffer.from('proof key'), () =>
      Promise.resolve({ ok: true, status: 200, body: '{}' }),
    );
    expect(fast.kind).toBe('delivered');
    release();
    expect(await slow).toMatchObject({ kind: 'gap', code: 'target_unreachable' });
    const gaps = await alpha.db.app.withBusiness(
      alpha.business,
      async (tx) =>
        await tx.query(
          'select from_tx::text, from_id from public.trace_export_gaps where business_id = $1',
          [alpha.business],
        ),
    );
    expect(gaps).toEqual([{ from_tx: null, from_id: null }]);
  } finally {
    release();
    await slow;
  }
});
