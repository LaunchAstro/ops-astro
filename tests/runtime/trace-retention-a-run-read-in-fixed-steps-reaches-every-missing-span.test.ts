// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#963, Sol PRV-oa-963-R3.1): two owed runs, R sorting
// first, both asked at C0 with their deletes queued. R's fresh E1..E3, S's
// F1..F97 and R's E4..E199 are exported in that order, then E200 and F98.
// The owed resend stores its first body (E1..E3, F1..F97), R's queued delete
// lands, then the other two bodies are stored: E1..E3 are missing. The store
// answers 97 reads a pass and unknown after, and never answers for S. R's
// reads must not settle into a cycle that reaches E1..E3 only past the
// allowance: every in-window span E1..E200 must come back.

import { expect, it } from 'vitest';
import {
  derivedId,
  expireOnce,
  exportOnce,
  TRACE_WINDOW_DAYS,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork } from './schedules-harness.ts';
import { age, append, eventIds } from './aw-13-retention-world.ts';
import { queuedAsk, rationed } from './aw-13-race-world.ts';
import { awaitDue, drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_fixed_step_reads');

it.skipIf(noDatabase)(
  'Trace retention: a run read in fixed steps still reaches every missing span',
  async () => {
    const s = t.alpha;
    const traceOf = (runId: string): string =>
      derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    const spanOf = (id: string): string => derivedId(TRACE_KEY, ['span', s.business, id], 16);
    const one = await liveWork(s, 'trace retention fixed steps one', 1_000);
    const two = await liveWork(s, 'trace retention fixed steps two', 1_000);
    // R sorts first by run id.
    const [workR, workS] =
      String(one.picked['runId']) < String(two.picked['runId']) ? [one, two] : [two, one];
    const runR = String(workR.picked['runId']);
    const runS = String(workS.picked['runId']);
    const held = (id: string): boolean =>
      t.target.spans.get(traceOf(runR))?.has(spanOf(id)) === true;
    await drain(s);
    await age(runR, TRACE_WINDOW_DAYS + 1);
    await age(runS, TRACE_WINDOW_DAYS + 1);
    const beforeR = new Set(await eventIds(runR));
    const beforeS = new Set(await eventIds(runS));

    // Both asks timed out at C0; neither queued delete has landed.
    await queuedAsk(s);
    await append(runR, 3);
    await append(runS, 97);
    await append(runR, 196);
    await awaitDue(s);
    await drain(s);
    await append(runR, 1);
    await append(runS, 1);
    await awaitDue(s);

    // The owed resend: its first body stored, R's delete, then the rest.
    let bodies = 0;
    expect(
      await exportOnce(s.db.app, s.business, TRACE_KEY, async (body) => {
        bodies += 1;
        if (bodies === 2) await t.target.expiry.expire([traceOf(runR)]);
        return await t.target.deliver(body);
      }),
    ).toMatchObject({ kind: 'delivered' });
    await drain(s);
    const fresh = (await eventIds(runR)).filter((id) => !beforeR.has(id));
    const freshS = (await eventIds(runS)).filter((id) => !beforeS.has(id));
    expect(fresh).toHaveLength(200);
    expect(freshS).toHaveLength(98);
    expect(
      fresh.filter((id) => !held(id)),
      'the delete took E1..E3 only',
    ).toEqual(fresh.slice(0, 3));

    const store = rationed(97, new Set(freshS.map(spanOf)));
    for (let round = 0; round < 12; round += 1) {
      store.pass();
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, store.ports);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(s);
    }
    expect(
      fresh.filter((id) => !held(id)),
      `every in-window span E1..E200 is held (${String(store.spans.length)} reads)`,
    ).toEqual([]);
  },
);
