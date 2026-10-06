// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): retention A selects
// run A at cursor C0 and is held at its delete; meanwhile a fresh A event and
// B's old pending event export to C1, and retention B deletes and confirms B.
// Retention A's rewind to C0 then replays B as well as A. A's fresh trace must
// come back, and B's confirmed expired trace must stay absent, or B must be
// due for deletion again.

import { expect, it } from 'vitest';
import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork } from './schedules-harness.ts';
import { age, batchesOf, handbackSpan } from './aw-13-retention-world.ts';
import { cursorOf, drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_other_run');

it.skipIf(noDatabase)(
  'Trace retention: a rewind for one run does not resurrect another run confirmed expired',
  async () => {
    const traceOf = (runId: string): string =>
      derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);

    // B: exported (registered), then a handback left pending beyond the cursor.
    const workB = await liveWork(t.alpha, 'trace retention other run B', 1000);
    const runB = String(workB.picked['runId']);
    await drain(t.alpha);
    // A: exported in full; the cursor is now C0.
    const workA = await liveWork(t.alpha, 'trace retention other run A', 1000);
    const runA = String(workA.picked['runId']);
    await drain(t.alpha);
    const c0 = await cursorOf(t.alpha);
    const pendingB = await asAgent(
      t.alpha,
      handbackBody(workB.picked),
      String(workB.picked['credential']),
    );
    expect(codeOf(pendingB)).toBe('applied');
    await age(runA, TRACE_WINDOW_DAYS + 1);
    await age(runB, TRACE_WINDOW_DAYS + 1);
    expect(t.target.stored.has(traceOf(runA))).toBe(true);
    expect(t.target.stored.has(traceOf(runB))).toBe(true);

    // Retention A, held at its delete after selecting A alone.
    const held: ExpiryPorts = {
      expire: async (ids) => {
        expect(ids).toEqual([traceOf(runA)]);
        // A fresh A event commits; export catches up on B's old pending event and A's fresh one to C1.
        const freshA = await asAgent(
          t.alpha,
          handbackBody(workA.picked),
          String(workA.picked['credential']),
        );
        expect(codeOf(freshA)).toBe('applied');
        await drain(t.alpha);
        expect(await cursorOf(t.alpha)).not.toBe(c0);
        // Retention B: deletes and confirms B; recent A is excluded.
        const passB = await expireOnce(
          t.alpha.db.app,
          t.alpha.business,
          TRACE_KEY,
          t.target.expiry,
        );
        expect(passB.at(-1)).toMatchObject({ code: null, confirmed: 1 });
        expect(t.target.stored.has(traceOf(runB))).toBe(false);
        expect((await batchesOf(t.alpha)).some((one) => one.expired_run_ids.includes(runB))).toBe(
          true,
        );
        // Release retention A's deletion.
        return await t.target.expiry.expire(ids);
      },
      present: t.target.expiry.present,
    };
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, held);

    // Recovery: drain the export, then retention again.
    await drain(t.alpha);
    // A's fresh handback's own span, not only some span under A's trace id.
    expect(
      t.target.spans.get(traceOf(runA))?.has(await handbackSpan(runA)) === true,
      'A’s fresh trace is restored',
    ).toBe(true);
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, t.target.expiry);
    await drain(t.alpha);
    expect(
      t.target.stored.has(traceOf(runB)),
      'B’s confirmed expired trace must stay absent, or be deleted again once replay recreates it',
    ).toBe(false);
  },
);
