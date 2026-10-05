// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#963): the export's lease creates a business's cursor row
// on its first export, before any advance, so the row can hold no place. A
// business whose every export has failed has registered trace copies but has
// sent nothing: once its run is past the window, a retention pass asks
// nothing for it and does not fail.

import { expect, it } from 'vitest';
import {
  exportOnce,
  expireOnce,
  TRACE_WINDOW_DAYS,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows } from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import { awaitDue, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_never_advanced');

it.skipIf(noDatabase)(
  'Trace retention: a business whose export never advanced is asked nothing, and its pass does not fail',
  async () => {
    const s = t.bravo;
    const work = await liveWork(s, 'trace retention never advanced', 1_000);
    await awaitDue(s);
    expect(
      await exportOnce(
        s.db.app,
        s.business,
        TRACE_KEY,
        async () => await Promise.resolve({ ok: false, fault: 'status', status: 503 }),
      ),
    ).toMatchObject({ kind: 'gap', code: 'target_refused' });
    await age(String(work.picked['runId']), TRACE_WINDOW_DAYS + 1);

    await expireOnce(s.db.app, s.business, TRACE_KEY, t.target.expiry);
    const [asks] = await rows<{ n: number }>(
      s,
      'select count(*)::int as n from public.trace_expiry_asks where business_id = $1',
      [s.business],
    );
    expect(asks?.n, 'no ask for a business that has sent nothing').toBe(0);
  },
);
