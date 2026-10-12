// SPDX-License-Identifier: AGPL-3.0-only
//
// P6 (docs/plan/sandbox-contract.md, section 6) within one running proxy: when
// the store dies between the daemon's create and the record's write, the
// daemon holds a container no record names. The same proxy, with no restart,
// sweeps it on its timer once the store is back, and serves nothing until
// that sweep is done. Against the fixture's doubles.

import { expect, it } from 'vitest';
import {
  C,
  create,
  GRACE,
  opened,
  S1_WALL,
  T0,
  UNAVAILABLE,
  world,
} from './proxy-state-fixture.ts';

it('a container whose record write failed is swept by the same proxy once the store is back', async () => {
  const w = world();
  const state = await opened(w);
  w.crashAfterCreate = true;
  expect(await state.handle(create(C))).toMatchObject({ ok: false, reason: 'internal' });
  expect(w.held.size).toBe(1);
  expect(await state.handle(create(C))).toEqual(UNAVAILABLE);

  w.crash = false;
  w.crashAfterCreate = false;
  w.now = T0 + S1_WALL + GRACE + 1;
  await state.tick();
  await state.tick();

  expect(w.held.size).toBe(0);
});
