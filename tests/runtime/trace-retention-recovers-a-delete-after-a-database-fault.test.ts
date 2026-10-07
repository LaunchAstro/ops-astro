// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): retention selects an
// old exported run, a fresh handback of it exports, the delete removes the
// whole trace, and the database fails once on the first post-delete resend.
// After the database recovers, durable work must restore the fresh trace.

import { expect, it } from 'vitest';
import type { ExpiryPorts, TraceDatabase } from '../../packages/core-runtime/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork } from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import {
  cursorOf,
  drain,
  exportFor,
  noDatabase,
  t,
  TRACE_KEY,
  useAw13World,
} from './aw-13-world.ts';

useAw13World('trret_db_fault');

it.skipIf(noDatabase)(
  'Trace retention: a database failure after the delete does not lose the fresh trace',
  async () => {
    // One exported run aged beyond the window: cursor C0, its trace stored.
    const work = await liveWork(t.alpha, 'trace retention db fault', 1000);
    const runId = String(work.picked['runId']);
    const traceId = derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);
    await drain(t.alpha);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const c0 = await cursorOf(t.alpha);
    expect(t.target.stored.has(traceId)).toBe(true);

    // The database, failing exactly the first withBusiness after the delete.
    let failNext = false;
    let failed = 0;
    const database: TraceDatabase = {
      withBusiness: async (businessId, run) => {
        if (failNext) {
          failNext = false;
          failed += 1;
          throw new Error('injected database failure after the delete');
        }
        return await t.alpha.db.app.withBusiness(businessId, run);
      },
    };

    let c1 = '';
    const ports: ExpiryPorts = {
      expire: async (ids) => {
        expect(ids).toContain(traceId);
        // Held after selection: R's fresh handback commits and exports to C1.
        const answer = await asAgent(
          t.alpha,
          handbackBody(work.picked),
          String(work.picked['credential']),
        );
        expect(codeOf(answer)).toBe('applied');
        await drain(t.alpha);
        c1 = await cursorOf(t.alpha);
        expect(c1).not.toBe(c0);
        expect(t.target.stored.has(traceId)).toBe(true);
        // Released: the delete removes R's whole trace and answers success.
        const deleted = await t.target.expiry.expire(ids);
        expect(deleted.ok).toBe(true);
        expect(t.target.stored.has(traceId)).toBe(false);
        failNext = true;
        return deleted;
      },
      present: t.target.expiry.present,
    };
    await expect(expireOnce(database, t.alpha.business, TRACE_KEY, ports)).rejects.toThrow(
      'injected database failure after the delete',
    );
    expect(failed).toBe(1);

    // Database restored; export and retention again, the fresh event inside the window.
    await exportFor(t.alpha);
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, t.target.expiry);
    await exportFor(t.alpha);
    // The fresh handback's own span, not only some span under R's trace id.
    const [fresh] = await t.alpha.db.app.withBusiness(
      t.alpha.business,
      async (tx) =>
        await tx.query<{ readonly id: string }>(
          `select id from public.run_events
            where business_id = $1 and run_id = $2 and kind = 'handed_back'`,
          [tx.businessId, runId],
        ),
    );
    const freshSpan = derivedId(TRACE_KEY, ['span', t.alpha.business, String(fresh?.id)], 16);
    expect(
      t.target.spans.get(traceId)?.has(freshSpan) === true,
      'after the database recovers, durable work must restore the deleted fresh trace',
    ).toBe(true);
  },
);
