// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): the trace store
// accepts a delete, the caller times out, recovery re-exports a fresh
// handback, and the accepted delete then executes. The fresh event must stay
// retrievable, or durable recovery work must export it again.

import { expect, it } from 'vitest';
import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
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

useAw13World('trret_late_delete');

it.skipIf(noDatabase)(
  'Trace retention: a delete accepted before a timeout cannot remove the recovered fresh trace',
  async () => {
    // One exported run aged beyond the window: cursor C0, its trace stored.
    const work = await liveWork(t.alpha, 'trace retention late delete', 1000);
    const runId = String(work.picked['runId']);
    const traceId = derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);
    await drain(t.alpha);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const c0 = await cursorOf(t.alpha);
    expect(t.target.stored.has(traceId)).toBe(true);

    // The store accepts the delete and queues it; the caller times out first.
    let queued: (() => Promise<unknown>) | undefined;
    let c1 = '';
    const ports: ExpiryPorts = {
      expire: async (ids) => {
        expect(ids).toContain(traceId);
        queued = async () => await t.target.expiry.expire(ids);
        // After selection: a fresh handback commits and exports to C1.
        const answer = await asAgent(
          t.alpha,
          handbackBody(work.picked),
          String(work.picked['credential']),
        );
        expect(codeOf(answer)).toBe('applied');
        await drain(t.alpha);
        c1 = await cursorOf(t.alpha);
        expect(c1).not.toBe(c0);
        return { ok: false, fault: 'timeout', status: null };
      },
      present: t.target.expiry.present,
    };
    const batches = await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, ports);
    expect(batches.at(-1)).toMatchObject({ code: 'target_timeout' });

    // Both rewinds done: export drains back to C1, re-sending the fresh trace.
    await drain(t.alpha);
    expect(await cursorOf(t.alpha)).toBe(c1);
    expect(t.target.stored.has(traceId)).toBe(true);

    // The accepted delete now executes.
    if (queued === undefined) throw new Error('no delete was queued');
    await queued();

    // Export and retention again, the fresh event still inside the window.
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
      'the fresh event must remain retrievable or be exported again after the accepted delete',
    ).toBe(true);
  },
);
