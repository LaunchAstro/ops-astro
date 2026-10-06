// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#963, Sol PRV-oa-963-R2.2): run R's delete is owed and
// the export resends E1..E150 with E151. Its first body (E1..E100) is
// stored, the queued delete lands, then its second (E101..E151) is stored:
// E1..E100 are missing. Every read of E151's span answers unknown; every
// other read is answered. Retention must still read an older missing span,
// and every in-window span E1..E151 must come back.

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

useAw13World('trret_unanswered_newer_span');

it.skipIf(noDatabase)(
  'Trace retention: an unanswered newer span hides no older missing one',
  async () => {
    const s = t.alpha;
    const work = await liveWork(s, 'trace retention unanswered newer span', 1_000);
    const runId = String(work.picked['runId']);
    const traceR = derivedId(TRACE_KEY, ['trace', s.business, runId], 32);
    const spanOf = (id: string): string => derivedId(TRACE_KEY, ['span', s.business, id], 16);
    const held = (id: string): boolean => t.target.spans.get(traceR)?.has(spanOf(id)) === true;
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const before = new Set(await eventIds(runId));

    const land = await queuedAsk(s);
    await append(runId, 150);
    await awaitDue(s);
    await drain(s);
    await append(runId, 1);
    await awaitDue(s);

    // The resend: its first body stored, the delete, then its second body.
    let bodies = 0;
    expect(
      await exportOnce(s.db.app, s.business, TRACE_KEY, async (body) => {
        bodies += 1;
        if (bodies === 2) await land();
        return await t.target.deliver(body);
      }),
    ).toMatchObject({ kind: 'delivered' });
    const fresh = (await eventIds(runId)).filter((id) => !before.has(id));
    expect(fresh).toHaveLength(151);
    expect(
      fresh.filter((id) => !held(id)),
      'the delete took E1..E100',
    ).toEqual(fresh.slice(0, 100));

    const store = rationed(Number.POSITIVE_INFINITY, new Set([spanOf(fresh.at(-1) ?? '')]));
    for (let round = 0; round < 5; round += 1) {
      store.pass();
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(s.db.app, s.business, TRACE_KEY, store.ports);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(s);
    }
    expect(
      fresh.filter((id) => !held(id)),
      'every in-window span E1..E151 is held',
    ).toEqual([]);
  },
);
