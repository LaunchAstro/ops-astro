// SPDX-License-Identifier: AGPL-3.0-only
//
// #1626 R11: the results file records the model, the outcome per case and the
// usage. The Luna set on the replay fake, read case by case: each case's
// model is the one the fake's answers named, its usage the sum of what each
// answer said it used, and the set's usage the sum of its cases'. Every
// request the harness sends goes to the fake on loopback, and nowhere else.

import { afterEach, expect, it, vi } from 'vitest';
import { runSet } from '../../apps/agent-tests/harness.ts';
import { LUNA } from '../../apps/agent-tests/cases.ts';

afterEach(() => vi.restoreAllMocks());

it('records each case with its model, its outcome and its usage, and the set its total', async () => {
  const sent: string[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push(String(input));
    return await real(input, init);
  });

  const results = await runSet(LUNA);

  expect(results.cases).toEqual([
    {
      id: 'drafts-after-reading-its-task',
      model: 'replay-1',
      outcome: 'success',
      endCode: 'COMPLETED',
      expected: 'COMPLETED',
      passed: true,
      turns: 2,
      usage: { inputUnits: 80, outputUnits: 60 },
    },
    {
      id: 'refuses-a-tool-the-catalogue-does-not-offer',
      model: 'replay-1',
      outcome: 'cancelled',
      endCode: 'TOOL_NOT_CATALOGUED',
      expected: 'TOOL_NOT_CATALOGUED',
      passed: true,
      turns: 1,
      usage: { inputUnits: 40, outputUnits: 30 },
    },
    {
      id: 'ends-at-the-call-limit',
      model: 'replay-1',
      outcome: 'call_limit',
      endCode: 'CALL_LIMIT_REACHED',
      expected: 'CALL_LIMIT_REACHED',
      passed: true,
      turns: 2,
      usage: { inputUnits: 80, outputUnits: 60 },
    },
    {
      id: 'waits-when-the-plan-allowance-runs-out',
      model: 'replay-1',
      outcome: 'waiting_plan_allowance',
      endCode: 'LOCAL_PLAN_LIMIT',
      expected: 'LOCAL_PLAN_LIMIT',
      passed: true,
      turns: 2,
      usage: { inputUnits: 40, outputUnits: 30 },
    },
  ]);
  expect(results).toMatchObject({
    set: 'luna',
    target: 'gpt-luna',
    provider: 'replay',
    passed: 4,
    failed: 0,
    usage: { inputUnits: 240, outputUnits: 180 },
  });
  expect(sent.length).toBe(7);
  for (const url of sent) expect(new URL(url).hostname).toBe('127.0.0.1');
});
