// SPDX-License-Identifier: AGPL-3.0-only
//
// P4 and P6 (docs/plan/sandbox-contract.md, section 6): the proxy reads a
// run's calls in the order the launcher sent them. A wait sent before its
// container's start was answered 204 is no run's end, even when its answer
// arrives after that start's. A start sent at or after the deadline is
// refused, and one that lands after a deadline kill is killed again at the
// next tick, so a killed container never runs on, a failed sweep's wait
// included. A launcher call the
// daemon drops (a throw) answers `internal`, and a dropped delete of the
// recorded container starts a sweep as any failed delete does. Every case
// runs against the fixture's doubles, not a real daemon.

import { expect, it } from 'vitest';
import {
  C,
  candidateOf,
  containerId,
  create,
  heldId,
  hold,
  op,
  opened,
  P,
  record,
  refused,
  S1_WALL,
  s1,
  T0,
  UNAVAILABLE,
  world,
} from './proxy-state-fixture.ts';

const ID = containerId(1);

it('counts no wait sent before the start was answered, whenever its answer lands', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(C));
  const release = hold(w, 'wait');
  const early = state.handle(op('wait', ID));
  await state.handle(op('start', ID));
  release();
  await early;
  expect(candidateOf(w)?.runs).toEqual([{ statusCode: null, inTime: false }]);
  expect(record(w).containers.container?.waitAt).toBeNull();
  await state.handle(op('wait', ID));
  expect(candidateOf(w)?.runs).toEqual([{ statusCode: 0, inTime: true }]);
});

it('refuses a start at or after the deadline', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.now = T0 + S1_WALL;
  w.calls.length = 0;
  expect(await state.handle(op('start', ID))).toEqual(refused('deadline'));
  expect(w.calls).toEqual([]);
});

it('kills again at the next tick when a start sent before the deadline lands after a kill', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  const release = hold(w, 'start');
  w.now = T0 + S1_WALL - 1;
  const late = state.handle(op('start', ID));
  w.now += 1;
  w.answer.kill = 409;
  await state.tick();
  release();
  await late;
  await state.tick();
  expect(w.calls.filter((call) => call === 'kill')).toHaveLength(2);
});

it('kills a recorded container at its deadline while a failed sweep waits to repeat', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.answer.delete = 409;
  w.listBroken = true;
  await state.handle(op('delete', ID));
  expect(await state.handle({ kind: 'ping' })).toEqual(UNAVAILABLE);
  w.now = T0 + S1_WALL;
  w.calls.length = 0;
  await state.tick();
  expect(w.calls).toEqual(['kill', 'list']);
});

it('answers a dropped launcher call internal, and sweeps after a dropped delete', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.throws.add('start').add('delete');
  const dropped = { ok: false, reason: 'internal', why: 'reply status' };
  expect(await state.handle(op('start', ID))).toEqual(dropped);
  w.calls.length = 0;
  expect(await state.handle(op('delete', ID))).toEqual(dropped);
  expect(w.calls).toEqual(['delete', 'list', 'remove', 'list', 'info']);
  expect(heldId(w)).toBeNull();
});
