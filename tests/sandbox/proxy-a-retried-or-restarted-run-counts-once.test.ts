// SPDX-License-Identifier: AGPL-3.0-only
//
// P3 and P6 (docs/plan/sandbox-contract.md, section 6) around the two steps a
// run's count rests on: the create's record write and the start's reply. A
// launcher that retries a create after its record write failed is told
// `unavailable` until the timer's sweep, then its retry is recorded and
// counted once. A proxy restarted while a start reply is out sweeps that
// container, and the next run counts in time. A start whose reply was lost
// and is sent again counts its run once. Against the fixture's doubles.

import { expect, it } from 'vitest';
import {
  C,
  candidateOf,
  containerId,
  create,
  GRACE,
  heldId,
  hold,
  op,
  opened,
  S1_WALL,
  settle,
  T0,
  UNAVAILABLE,
  world,
} from './proxy-state-fixture.ts';

it('a create retried after its record write failed is unavailable until the sweep, then counted once', async () => {
  const w = world();
  const state = await opened(w);
  const left = candidateOf(w)?.createsLeft ?? 0;
  w.crashAfterCreate = true;
  expect(await state.handle(create(C))).toMatchObject({ ok: false, reason: 'internal' });
  w.crash = false;
  w.crashAfterCreate = false;
  // The launcher's retry, and a run operation on the container the record missed.
  expect(await state.handle(create(C))).toEqual(UNAVAILABLE);
  expect(await state.handle(op('start', containerId(1)))).toEqual(UNAVAILABLE);
  await state.tick();
  expect(w.held.size).toBe(0);

  expect(await state.handle(create(C))).toMatchObject({ ok: true, reply: { status: 201 } });
  expect(w.held).toEqual(new Set([containerId(2)]));
  expect(heldId(w)).toBe(containerId(2));
  expect(candidateOf(w)?.createsLeft).toBe(left - 1);
});

it('a proxy restarted while a start reply is out sweeps that container, and the next run counts', async () => {
  const w = world();
  const first = await opened(w);
  await first.handle(create(C));
  const release = hold(w, 'start');
  const lateStart = first.handle(op('start', containerId(1)));
  await settle();

  const restarted = await opened(w);
  expect(w.held.size).toBe(0);
  expect(heldId(w)).toBeNull();
  release();
  await lateStart;
  expect(await restarted.handle(op('wait', containerId(1)))).toMatchObject({ ok: false });

  await restarted.handle(create(C));
  await restarted.handle(op('start', containerId(2)));
  await restarted.handle(op('wait', containerId(2)));
  expect(candidateOf(w)?.runs.at(-1)).toEqual({ statusCode: 0, inTime: true });
});

it('a start sent again after its reply was lost counts its run once, in time', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(C));
  w.throws.add('start');
  expect(await state.handle(op('start', containerId(1)))).toMatchObject({
    ok: false,
    reason: 'internal',
  });
  w.throws.delete('start');
  expect(await state.handle(op('start', containerId(1)))).toMatchObject({ ok: true });
  w.now = T0 + S1_WALL - GRACE;
  await state.handle(op('wait', containerId(1)));
  expect(candidateOf(w)?.runs).toEqual([{ statusCode: 0, inTime: true }]);
});
