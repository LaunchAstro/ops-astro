// SPDX-License-Identifier: AGPL-3.0-only
//
// P3 (docs/plan/sandbox-contract.md, section 6) when a start reply lands late:
// a start answered for a container the timer has since deleted is that
// container's, and never marks the next container's run as not started. The
// next container's own start and wait still count its run, in time. Driven by
// the fixture's held start and `settle()`, against its doubles.

import { expect, it } from 'vitest';
import {
  C,
  candidateOf,
  containerId,
  create,
  GRACE,
  hold,
  op,
  opened,
  record,
  S1_WALL,
  settle,
  T0,
  world,
} from './proxy-state-fixture.ts';

it("a deleted container's late start reply leaves the next container's run counted", async () => {
  const w = world();
  const state = await opened(w);
  const [first, next] = [containerId(1), containerId(2)];
  await state.handle(create(C));
  const release = hold(w, 'start');
  const lateStart = state.handle(op('start', first));
  await settle();
  // The timer kills and then deletes the first container while its start reply is out.
  w.now = T0 + S1_WALL;
  await state.tick();
  w.now = T0 + S1_WALL + GRACE;
  await state.tick();
  expect(record(w).containers.container).toBeNull();

  await state.handle(create(C));
  expect(record(w).containers.container?.id).toBe(next);
  await state.handle(op('start', next));
  release();
  await lateStart;
  await state.handle(op('wait', next));

  expect(candidateOf(w)?.runs.at(-1)).toEqual({ statusCode: 0, inTime: true });
  expect(record(w).containers.container?.waitAt).toBe(w.now);
});
