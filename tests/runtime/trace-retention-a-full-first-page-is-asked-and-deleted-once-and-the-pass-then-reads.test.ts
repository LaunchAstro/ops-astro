// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: a pass asks and deletes its due runs page after page
// before it reads anything, and confirms nothing on one read. Each page is
// selected after the last run of the one before, so a full first page is
// deleted once, the next page follows, and the pass then reads every run
// back. A run read gone and awaiting its second read is owed, not due: the
// next pass deletes nothing again.

import { expect, it } from 'vitest';
import { noDatabase, t, useAw13World } from './aw-13-world.ts';
import { dueRuns, pass, traceOf, watched } from './trace-retention-pass-world.ts';

useAw13World('trret_full_first_page');

it.skipIf(noDatabase)(
  'Trace retention: a full first page is asked and deleted once and the pass then reads',
  async () => {
    const s = t.alpha;
    const runs = await dueRuns(s, 'trace retention full first page', 4);
    const traces = runs.map((runId) => traceOf(s, runId));

    const first = watched();
    await pass(s, first.ports, { page: 2 });
    const deleted = first.seen.filter((one) => one.op === 'DELETE').map((one) => one.trace);
    expect(deleted.toSorted(), 'every due run deleted once').toEqual(traces.toSorted());
    const lastDelete = first.seen.findLastIndex((one) => one.op === 'DELETE');
    const firstRead = first.seen.findIndex((one) => one.op === 'GET');
    expect(firstRead, 'every page is deleted before the pass reads').toBeGreaterThan(lastDelete);
    expect(
      first.seen
        .filter((one) => one.op === 'GET')
        .map((one) => one.trace)
        .toSorted(),
      'then every run is read back once',
    ).toEqual(traces.toSorted());

    const next = watched();
    await pass(s, next.ports, { page: 2 });
    expect(
      next.seen.filter((one) => one.op === 'DELETE'),
      'a run awaiting its second read is not deleted again',
    ).toEqual([]);
  },
);
