// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the trigger read on real runs. The reading is the run's
// accept-time manifest (AW-04) against the replay provider's window; the
// delegation is AW-11's hand-over on the run. "Not yet" carries the two
// figures; a manifest it cannot count is refused, never read as nothing.

import { expect, it as vitestIt } from 'vitest';
import { DELEGATION_DEPTH_BUILT } from '../../packages/core-runtime/src/index.ts';
import { child, insertRaw, noDatabase, useChildWorld, w } from '../runtime/aw-11-child-world.ts';
import { parentWork } from '../runtime/aw-11-child-world.ts';
import { pinReading, runOf, shapedWork, triggerAs } from './aw-12-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw12t');

const figures = (units: number, depth: number): object => ({
  reading: { units, unit: 'utf8_byte', windowUnits: 32_000, model: 'replay-1' },
  delegation: { depth, builtDepth: 1 },
});

it('AW-12 trigger read: a delegated run whose pinned reading fits one window is "not yet", with its two figures', async () => {
  const { runId } = await shapedWork(w.s, [1_200, 800], w.helper);
  expect(await triggerAs(w.s, w.s.decider, runId)).toEqual({
    result: 'not_yet',
    missing: ['reading'],
    figures: figures(2_000, 1),
  });
});

it('AW-12 trigger read: a run that does not sub-delegate is "not yet", however much it reads', async () => {
  const { runId } = await shapedWork(w.s, [40_000]);
  expect(await triggerAs(w.s, w.s.decider, runId)).toEqual({
    result: 'not_yet',
    missing: ['delegation'],
    figures: figures(40_000, 0),
  });
  // A run with no pin reads nothing.
  const { runId: unpinned } = await shapedWork(w.s, []);
  expect(await triggerAs(w.s, w.s.decider, unpinned)).toMatchObject({
    result: 'not_yet',
    missing: ['reading', 'delegation'],
    figures: { reading: { units: 0 } },
  });
});

it('AW-12 trigger read: it fires only when the reading exceeds the window and the run sub-delegates', async () => {
  const { runId } = await shapedWork(w.s, [20_000, 12_001], w.helper);
  expect(await triggerAs(w.s, w.s.decider, runId)).toEqual({
    result: 'fired',
    figures: figures(32_001, 1),
  });
  const edge = await shapedWork(w.s, [20_000, 12_000], w.helper);
  expect(await triggerAs(w.s, w.s.decider, edge.runId)).toMatchObject({
    result: 'not_yet',
    missing: ['reading'],
  });
});

it('AW-12 trigger read: the same bytes at two paths are one file, read once', async () => {
  const { runId } = await shapedWork(w.s, [], w.helper);
  const digest = 'd'.repeat(64);
  await pinReading(
    w.s,
    runId,
    [16_001],
    [
      { path: 'skills/a.md', digest, size: 16_001 },
      { path: 'skills/copy-of-a.md', digest, size: 16_001 },
    ],
  );
  expect(await triggerAs(w.s, w.s.decider, runId)).toEqual({
    result: 'not_yet',
    missing: ['reading'],
    figures: figures(16_001, 1),
  });
});

it('AW-12 trigger read: a manifest it cannot count is refused, never read as nothing', async () => {
  const hostile: unknown[][] = [
    [{ path: 'a.md', digest: 'x', size: '40000' }],
    [{ path: 'a.md', digest: 'x' }],
    // No digest: two such entries could not be told apart, so none is counted.
    [{ path: 'a.md', size: 40_000 }],
    [{ path: 'a.md', digest: 'x', size: -5 }],
    [{ path: 'a.md', digest: 'x', size: 1.5 }],
    ['a.md'],
    // Each size whole, the sum past what a figure can hold exactly.
    Array.from({ length: 10 }, (_, i) => ({
      path: `b${String(i)}.md`,
      digest: `x${String(i)}`,
      size: 999_999_999_999_999,
    })),
  ];
  for (const entries of hostile) {
    // Sequential: each run is picked up in turn.
    // eslint-disable-next-line no-await-in-loop
    const { work } = await parentWork(w.s);
    // eslint-disable-next-line no-await-in-loop
    await pinReading(w.s, runOf(work), [1], entries);
    // eslint-disable-next-line no-await-in-loop
    const read = await triggerAs(w.s, w.s.decider, runOf(work));
    expect(read, JSON.stringify(entries)).toMatchObject({ code: 'DEFINITION_UNAVAILABLE' });
    expect(JSON.stringify(read)).not.toMatch(/units|not_yet|fired/u);
  }
});

it('AW-12 trigger read: the depth built is the depth the database admits', async () => {
  const { parent } = await parentWork(w.s);
  const first = await child(w.s, parent, w.helper);
  const grandchild = await insertRaw(w.s, first.delegation.id, w.helper, {
    collections: ['task'],
    actions: ['read'],
  });
  expect(grandchild).toMatch(/depth one/u);
  expect(DELEGATION_DEPTH_BUILT).toBe(1);
});
