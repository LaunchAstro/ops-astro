// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: an owed run whose fresh span went out inside the window
// may read 404 only because the store has not ingested it yet. One such
// absence moves nothing: the export cursor stays where it is and nothing is
// sent again. A second absence in the next pass is a delete that landed, and
// the run recovers: the cursor steps back and the span goes again. A present
// answer between two absences resets the count, and the run is left alone.

import { expect, it } from 'vitest';
import { drain, noDatabase, t, useAw13World } from './aw-13-world.ts';
import {
  cursorOf,
  lastEvent,
  owedRuns,
  pass,
  spanOf,
  traceOf,
} from './trace-retention-pass-world.ts';

useAw13World('trret_recent_404');

const s = (): typeof t.alpha => t.alpha;

/** The run's fresh span, and whether the target holds it. */
async function freshSpan(runId: string): Promise<{ span: string; held: () => boolean }> {
  const span = spanOf(s(), await lastEvent(s(), runId));
  return { span, held: () => t.target.spans.get(traceOf(s(), runId))?.has(span) === true };
}

/** The store loses the span for now, as one not yet ingested would read. */
function unIngest(runId: string, span: string): void {
  t.target.spans.get(traceOf(s(), runId))?.delete(span);
}

it.skipIf(noDatabase)(
  'Trace retention: a recent 404 is neither rewound nor resent until absent again',
  async () => {
    const [runId = ''] = await owedRuns(s(), 'trace retention recent 404', 1);
    const { span, held } = await freshSpan(runId);
    const before = await cursorOf(s());

    unIngest(runId, span);
    await pass(s(), t.target.expiry);
    expect(await cursorOf(s()), 'one absence does not step the cursor back').toBe(before);
    await drain(s());
    expect(held(), 'nor is the span sent again').toBe(false);

    await pass(s(), t.target.expiry);
    expect(await cursorOf(s()), 'a second absence steps the cursor back').not.toBe(before);
    await drain(s());
    expect(held(), 'and the span goes again').toBe(true);
  },
);

it.skipIf(noDatabase)(
  'Trace retention: a present answer between two recent 404s resets them',
  async () => {
    const [runId = ''] = await owedRuns(s(), 'trace retention recent 404 reset', 1);
    const { span, held } = await freshSpan(runId);
    const before = await cursorOf(s());

    unIngest(runId, span);
    await pass(s(), t.target.expiry);
    t.target.spans.get(traceOf(s(), runId))?.add(span);
    await pass(s(), t.target.expiry);
    unIngest(runId, span);
    await pass(s(), t.target.expiry);
    expect(await cursorOf(s()), 'absent, present, absent steps nothing back').toBe(before);
    await drain(s());
    expect(held(), 'and sends nothing again').toBe(false);
  },
);
