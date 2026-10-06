// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#963, Sol PRV-oa-963-R2.1): two owed runs, A sorting
// first, both asked at C0 with their deletes queued. A has four fresh events
// and B a fresh handback, all exported; then only B's delete lands. The
// store answers four reads a pass and 429 after. A's four spans read present
// on every pass; retention must still reach B, read it gone and send its
// fresh handback again.

import { expect, it } from 'vitest';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork } from './schedules-harness.ts';
import { age, append, handbackSpan } from './aw-13-retention-world.ts';
import { queuedAsk, rationed } from './aw-13-race-world.ts';
import { awaitDue, drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_present_run_spends_reads');

it.skipIf(noDatabase)(
  'Trace retention: a present run cannot spend every read before a gone one',
  async () => {
    const s = t.alpha;
    const traceOf = (runId: string): string =>
      derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    const one = await liveWork(s, 'trace retention reads spent one', 1_000);
    const two = await liveWork(s, 'trace retention reads spent two', 1_000);
    // A sorts first by run id.
    const [workA, workB] =
      String(one.picked['runId']) < String(two.picked['runId']) ? [one, two] : [two, one];
    const runA = String(workA.picked['runId']);
    const runB = String(workB.picked['runId']);
    await drain(s);
    await age(runA, TRACE_WINDOW_DAYS + 1);
    await age(runB, TRACE_WINDOW_DAYS + 1);

    await queuedAsk(s);
    await append(runA, 4);
    expect(
      codeOf(await asAgent(s, handbackBody(workB.picked), String(workB.picked['credential']))),
    ).toBe('applied');
    await awaitDue(s);
    await drain(s);
    const freshB = await handbackSpan(runB);
    expect(t.target.spans.get(traceOf(runB))?.has(freshB)).toBe(true);
    // Only B's queued delete lands.
    expect(await t.target.expiry.expire([traceOf(runB)])).toMatchObject({ ok: true });
    expect(t.target.stored.has(traceOf(runB))).toBe(false);

    const store = rationed(4);
    for (let round = 0; round < 5; round += 1) {
      store.pass();
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, store.ports);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(s);
    }
    expect(t.target.stored.has(traceOf(runA)), 'A stays present').toBe(true);
    expect(
      t.target.spans.get(traceOf(runB))?.has(freshB) === true,
      'retention reaches B past A’s present spans and sends its fresh handback again',
    ).toBe(true);
  },
);
