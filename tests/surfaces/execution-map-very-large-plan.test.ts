// SPDX-License-Identifier: AGPL-3.0-only
//
// The execution map reads a plan the server bound, so its size is the
// server's, not the browser's. A very wide plan or a very deep chain still
// places every step: neither the column count nor a step's depth is worked
// out with a call per step on the stack.

import { describe, expect, it } from 'vitest';
import { executionMap, type MapGraph } from '../../packages/ui/src/state/execution-map.ts';

const STEPS = 200_000;

const plan = (after: (index: number) => readonly string[]): MapGraph => ({
  plan: 'bound',
  steps: Array.from({ length: STEPS }, (_, index) => ({
    key: `s${String(index)}`,
    title: `Step ${String(index)}`,
    after: after(index),
    runIds: [],
  })),
  nodes: [],
});

describe('the execution map over a very large plan', () => {
  it('places a plan of 200,000 side-by-side steps in one column', () => {
    const view = executionMap(
      plan(() => []),
      [],
    );
    expect(view.kind === 'bound' ? [view.steps.length, view.stages] : view.kind).toStrictEqual([
      STEPS,
      1,
    ]);
  });

  it('places a chain of 200,000 steps one column apart, listed last step first', () => {
    const view = executionMap(
      plan((index) => (index === STEPS - 1 ? [] : [`s${String(index + 1)}`])),
      [],
    );
    expect(view.kind === 'bound' ? [view.steps[0]?.col, view.stages] : view.kind).toStrictEqual([
      STEPS - 1,
      STEPS,
    ]);
  });
});
