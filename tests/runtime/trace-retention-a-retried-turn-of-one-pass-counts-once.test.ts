// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: a business turn retried within one deployment pass keeps
// the pass's identity, so its reads count as that one pass. Two absences
// read in one pass and its retry confirm nothing; an absence in the next
// pass confirms the run.

import { expect, it } from 'vitest';
import { passBudget } from '../../packages/core-runtime/src/trace-store.ts';
import { noDatabase, t, useAw13World } from './aw-13-world.ts';
import { confirmed, dueRuns, pass } from './trace-retention-pass-world.ts';

useAw13World('trret_retried_turn');

it.skipIf(noDatabase)('Trace retention: a retried turn of one pass counts once', async () => {
  const s = t.alpha;
  const [runId = ''] = await dueRuns(s, 'trace retention retried turn', 1);
  const budget = passBudget();
  await pass(s, t.target.expiry, { budget });
  expect(await confirmed(s, runId), 'one absence confirms nothing').toBe(false);
  await pass(s, t.target.expiry, { budget });
  expect(await confirmed(s, runId), 'the retry is the same pass').toBe(false);
  await pass(s, t.target.expiry, { budget: passBudget() });
  expect(await confirmed(s, runId), 'the next pass confirms the run').toBe(true);
});
