// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): a page of earlier owed asks whose traces stay
// present must not hide a later owed run whose fresh trace was deleted.

import { expect, it } from 'vitest';
import type { ExpiryPorts, TraceDatabase } from '../../packages/core-runtime/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork } from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import { cursorOf, drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_owed_pages');

it.skipIf(noDatabase)(
  'Trace retention: recovery reaches a later owed run past a present earlier one',
  async () => {
    const traceOf = (runId: string): string =>
      derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);

    // Two registered runs A and B, both exported.
    const workA = await liveWork(t.alpha, 'trace retention owed page A', 1000);
    const runA = String(workA.picked['runId']);
    const workB = await liveWork(t.alpha, 'trace retention owed page B', 1000);
    const runB = String(workB.picked['runId']);
    await drain(t.alpha);
    expect(t.target.stored.has(traceOf(runA))).toBe(true);
    expect(t.target.stored.has(traceOf(runB))).toBe(true);

    // A's owed ask at PA: its delete is queued and times out while a fresh A handback exports.
    await age(runA, TRACE_WINDOW_DAYS + 1);
    const timeoutA: ExpiryPorts = {
      expire: async (ids) => {
        expect(ids).toEqual([traceOf(runA)]);
        const fresh = await asAgent(
          t.alpha,
          handbackBody(workA.picked),
          String(workA.picked['credential']),
        );
        expect(codeOf(fresh)).toBe('applied');
        await drain(t.alpha);
        return { ok: false, fault: 'timeout', status: null };
      },
      present: t.target.expiry.present,
    };
    const passA = await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, timeoutA, {
      page: 1,
    });
    expect(passA.at(-1)).toMatchObject({ code: 'target_timeout' });
    await drain(t.alpha);
    const pa = await cursorOf(t.alpha);
    expect(t.target.stored.has(traceOf(runA))).toBe(true);

    // B's owed ask at PB > PA: a fresh B handback exports during the delete, the
    // delete lands, and the first post-delete transaction fails.
    await age(runB, TRACE_WINDOW_DAYS + 1);
    let failNext = false;
    const faulty: TraceDatabase = {
      withBusiness: async (businessId, run) => {
        if (failNext) {
          failNext = false;
          throw new Error('injected database failure after the delete');
        }
        return await t.alpha.db.app.withBusiness(businessId, run);
      },
    };
    const deleteB: ExpiryPorts = {
      expire: async (ids) => {
        expect(ids).toEqual([traceOf(runB)]);
        const fresh = await asAgent(
          t.alpha,
          handbackBody(workB.picked),
          String(workB.picked['credential']),
        );
        expect(codeOf(fresh)).toBe('applied');
        await drain(t.alpha);
        expect(await cursorOf(t.alpha)).not.toBe(pa);
        const deleted = await t.target.expiry.expire(ids);
        expect(deleted.ok).toBe(true);
        failNext = true;
        return deleted;
      },
      present: t.target.expiry.present,
    };
    await expect(
      expireOnce(faulty, t.alpha.business, TRACE_KEY, deleteB, { page: 1 }),
    ).rejects.toThrow('injected database failure after the delete');
    expect(t.target.stored.has(traceOf(runB))).toBe(false);

    // Database recovered: retention at page 1 and export, repeatedly, both fresh events inside the window.
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- one pass after another
      await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, t.target.expiry, { page: 1 });
      // eslint-disable-next-line no-await-in-loop -- one pass after another
      await drain(t.alpha);
    }
    expect(t.target.stored.has(traceOf(runA)), 'A stays present').toBe(true);
    expect(
      t.target.stored.has(traceOf(runB)),
      'recovery must read B absent and export its fresh span again despite A staying present',
    ).toBe(true);
  },
);
