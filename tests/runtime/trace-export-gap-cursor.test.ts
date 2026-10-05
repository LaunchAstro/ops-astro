// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { exportOnce } from '../../packages/core-runtime/src/trace-export.ts';
import { liveWork, openSchedules, type Schedules } from './schedules-harness.ts';

let alpha: Schedules;

beforeAll(async () => {
  alpha = await openSchedules('solow012', 1_000_000);
});

afterAll(async () => {
  await alpha?.db.drop();
});

it('a failed concurrent export records the cursor its batch was read from', async () => {
  await liveWork(alpha, 'gap concurrency', 1_000);
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
      Promise.resolve({ ok: true, status: 200, body: '{}' } as const),
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
