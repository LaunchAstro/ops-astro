// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: a pass that reads a run and has no answer records it as
// unread, and that resets the run's count of absences as a present answer
// does. Absent, unread, absent confirms nothing; one more absent pass then
// confirms the run.

import { expect, it } from 'vitest';
import { noDatabase, t, useAw13World } from './aw-13-world.ts';
import { confirmed, dueRuns, pass, traceOf, watched } from './trace-retention-pass-world.ts';

useAw13World('trret_absent_unread_absent');

it.skipIf(noDatabase)(
  'Trace retention: absent, then unread, then absent is not confirmed',
  async () => {
    const s = t.alpha;
    const [runId = ''] = await dueRuns(s, 'trace retention absent unread absent', 1);
    const trace = traceOf(s, runId);
    await pass(s, t.target.expiry);
    expect(await confirmed(s, runId), 'one absence confirms nothing').toBe(false);
    const unread = watched((asked) => (asked === trace ? 'unknown' : undefined));
    await pass(s, unread.ports);
    expect(
      unread.seen.map((one) => one.trace),
      'the second pass reads the run',
    ).toContain(trace);
    await pass(s, t.target.expiry);
    expect(await confirmed(s, runId), 'an unread result between resets the count').toBe(false);
    await pass(s, t.target.expiry);
    expect(await confirmed(s, runId), 'two absences in a row confirm the run').toBe(true);
  },
);
