// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: a run is confirmed gone only when its two latest results
// are both absent, from passes one after the other. A present answer between
// two absences resets the count, so absent, present, absent confirms
// nothing, and one more absent pass then confirms the run.

import { expect, it } from 'vitest';
import { noDatabase, t, useAw13World } from './aw-13-world.ts';
import { confirmed, dueRuns, pass, traceOf, watched } from './trace-retention-pass-world.ts';

useAw13World('trret_absent_present_absent');

it.skipIf(noDatabase)('Trace retention: absent, present, absent is not confirmed', async () => {
  const s = t.alpha;
  const [runId = ''] = await dueRuns(s, 'trace retention absent present absent', 1);
  const trace = traceOf(s, runId);
  await pass(s, t.target.expiry);
  expect(await confirmed(s, runId), 'one absence confirms nothing').toBe(false);
  await pass(s, watched((asked) => (asked === trace ? 'present' : undefined)).ports);
  await pass(s, t.target.expiry);
  expect(await confirmed(s, runId), 'a present answer between resets the count').toBe(false);
  await pass(s, t.target.expiry);
  expect(await confirmed(s, runId), 'two absences in a row confirm the run').toBe(true);
});
