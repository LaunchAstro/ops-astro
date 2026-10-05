// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): three earlier owed runs whose reads stay
// unknown must not stop every pass before a later owed run whose queued
// delete landed, so its fresh handback is restored.

import { expect, it } from 'vitest';
import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork } from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import { drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_unknown_prefix');

it.skipIf(noDatabase)(
  'Trace retention: unknown reads of earlier owed runs do not stop recovery of a later absent run',
  async () => {
    const traceOf = (runId: string): string =>
      derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);

    // Four registered runs, exported, aged beyond the window; sorted by run UUID: A, B, C, D.
    const works = [];
    for (let n = 0; n < 4; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- one run after another
      works.push(await liveWork(t.alpha, `trace retention unknown prefix ${String(n)}`, 1000));
    }
    await drain(t.alpha);
    for (const work of works) {
      // eslint-disable-next-line no-await-in-loop -- one run after another
      await age(String(work.picked['runId']), TRACE_WINDOW_DAYS + 1);
    }
    works.sort((x, y) => String(x.picked['runId']).localeCompare(String(y.picked['runId'])));
    const runs = works.map((work) => String(work.picked['runId']));
    const runD = runs[3] ?? '';
    const workD = works[3];
    if (workD === undefined) throw new Error('no fourth run');

    // The original delete for the four is queued and times out: four asks at C0.
    let queued: readonly string[] = [];
    const timeout: ExpiryPorts = {
      expire: (ids) => {
        queued = ids;
        return Promise.resolve({ ok: false, fault: 'timeout', status: null });
      },
      present: t.target.expiry.present,
    };
    const asked = await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, timeout);
    expect(asked.at(-1)).toMatchObject({ runs: 4, code: 'target_timeout' });
    expect([...queued].sort()).toEqual(runs.map(traceOf).sort());

    // A fresh handback for each, committed and exported inside the window.
    for (const work of works) {
      // eslint-disable-next-line no-await-in-loop -- one handback after another
      const answer = await asAgent(
        t.alpha,
        handbackBody(work.picked),
        String(work.picked['credential']),
      );
      expect(codeOf(answer)).toBe('applied');
    }
    await drain(t.alpha);
    const [fresh] = await t.alpha.db.app.withBusiness(
      t.alpha.business,
      async (tx) =>
        await tx.query<{ readonly id: string }>(
          `select id from public.run_events
            where business_id = $1 and run_id = $2 and kind = 'handed_back'`,
          [tx.businessId, runD],
        ),
    );
    const freshSpanD = derivedId(TRACE_KEY, ['span', t.alpha.business, String(fresh?.id)], 16);
    expect(t.target.spans.get(traceOf(runD))?.has(freshSpanD)).toBe(true);

    // Only D's queued delete lands: D is absent.
    expect((await t.target.expiry.expire([traceOf(runD)])).ok).toBe(true);
    expect(t.target.stored.has(traceOf(runD))).toBe(false);

    // A, B and C always read unknown; D reads through to the target.
    const unreadable = new Set(runs.slice(0, 3).map(traceOf));
    const requested: string[] = [];
    const ports: ExpiryPorts = {
      expire: (ids) => t.target.expiry.expire(ids),
      present: (traceId) => {
        requested.push(traceId);
        return unreadable.has(traceId)
          ? Promise.resolve('unknown' as const)
          : t.target.expiry.present(traceId);
      },
    };

    // Retention then export, repeatedly, every fresh handback still inside the window.
    for (let round = 0; round < 5; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- one pass after another
      await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, ports);
      // eslint-disable-next-line no-await-in-loop -- one pass after another
      await drain(t.alpha);
    }

    expect(requested, 'a read-back pass reaches D across retries').toContain(traceOf(runD));
    expect(
      t.target.spans.get(traceOf(runD))?.has(freshSpanD) === true,
      "D's fresh handback is restored despite unreadable earlier traces",
    ).toBe(true);
  },
);
