// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part two: the owner reads the harness test's result. `harness.read`
// is the trigger read (`readHarnessTrigger`) through its owning command: the
// person route and the command line give one answer, "not yet" with its two
// figures, or the trigger fired. Nothing is stored: the answer is computed
// from the run's frozen manifest on each read. The crossings are
// `aw-12-harness-read-isolation.test.ts`.

import { expect, it as vitestIt } from 'vitest';
import { noDatabase, useChildWorld, w } from '../runtime/aw-11-child-world.ts';
import { shapedWork } from './aw-12-world.ts';
import { harnessOnCli, harnessOver, useHarnessRoute } from './aw-12-route-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw12route');
useHarnessRoute();

const figures = (units: number, depth: number): object => ({
  reading: { units, unit: 'utf8_byte', windowUnits: 32_000, model: 'replay-1' },
  delegation: { depth, builtDepth: 1 },
});

it('AW-12 harness read: the harness result reads "not yet" with its two figures over the route', async () => {
  const { runId } = await shapedWork(w.s, [1_200, 800], w.helper);
  const answer = await harnessOver(w.s, w.s.decider, runId);
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({
    ok: true,
    harness: { result: 'not_yet', missing: ['reading'], figures: figures(2_000, 1) },
  });
  // Both limbs held: the route says the trigger fired, with the same two figures.
  const fired = await shapedWork(w.s, [20_000, 12_001], w.helper);
  expect(await harnessOver(w.s, w.s.decider, fired.runId)).toEqual({
    status: 200,
    body: { ok: true, harness: { result: 'fired', figures: figures(32_001, 1) } },
  });
});

it('AW-12 harness read: the same result on the command line', async () => {
  const { runId } = await shapedWork(w.s, [40_000]);
  const route = await harnessOver(w.s, w.s.decider, runId);
  const cli = await harnessOnCli(w.s, w.s.decider, runId);
  expect(cli.status).toBe(200);
  expect(cli.body).toEqual({
    ok: true,
    harness: { result: 'not_yet', missing: ['delegation'], figures: figures(40_000, 0) },
  });
  // The command line's answer is the route's, byte for byte.
  expect(cli.text).toBe(JSON.stringify(route.body));
});

it('AW-12 harness read: a run id that is not a string is refused naming runId, before any lookup', async () => {
  const answer = await harnessOver(w.s, w.s.decider, 7 as unknown as string);
  expect(answer.status).toBe(422);
  expect(answer.body).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['runId'] });
});
