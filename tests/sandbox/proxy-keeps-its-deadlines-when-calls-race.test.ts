// SPDX-License-Identifier: AGPL-3.0-only
//
// P3, P4 and P6 (docs/plan/sandbox-contract.md, section 6) when calls race:
// a wait is judged when its answer lands, not when its bookkeeping takes the
// lock; the timer's deadline kill and delete reach the daemon while a create
// holds the lock on its own I/O; a run whose container a sweep removed is
// `unavailable`, an answer that lands after that sweep included; and a deadline once reached stays reached
// when the wall clock steps back. Each interleaving is driven by the
// fixture's gates (a held store write, pin read or wait) and `settle()`, never
// by a sleep. Every case runs against the fixture's doubles, not a real
// daemon.

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
  P,
  record,
  refused,
  S1_WALL,
  s1,
  settle,
  T0,
  UNAVAILABLE,
  world,
} from './proxy-state-fixture.ts';

const ID = containerId(1);

it('judges a wait in time when it returned, not when its write took the lock', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(C));
  await state.handle(op('start', ID));
  const deadline = T0 + S1_WALL;
  w.now = deadline - 10;
  const release = hold(w, 'write');
  const ended = state.attachEnded(ID);
  await settle();
  w.now = deadline - 1;
  const waited = state.handle(op('wait', ID));
  await settle();
  w.now = deadline + 1;
  release();
  await Promise.all([ended, waited]);
  expect(candidateOf(w)?.runs).toEqual([{ statusCode: 0, inTime: true }]);
  expect(record(w).containers.container?.waitAt).toBe(deadline - 1);
});

it('kills and deletes on time while a create holds the lock on a slow pin read', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  await state.handle(op('start', ID));
  const deadline = T0 + S1_WALL;
  w.now = deadline - 1;
  const release = hold(w, 'pins');
  const second = state.handle(create(P, s1('p')));
  await settle();
  w.calls.length = 0;
  w.now = deadline;
  const killed = state.tick();
  await settle();
  w.now = deadline + GRACE;
  const deleted = state.tick();
  await settle();
  expect(w.calls).toEqual(['kill', 'kill', 'delete']);
  release();
  expect(await second).toMatchObject({ ok: false, reason: 'proxy refused' });
  await Promise.all([killed, deleted]);
  expect([heldId(w), w.held.size]).toEqual([null, 0]);
});

it('refuses a run whose container a sweep removed as unavailable', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.answer.delete = 500;
  w.now = T0 + S1_WALL + GRACE;
  await state.tick();
  expect(await state.handle(op('wait', ID))).toEqual(UNAVAILABLE);
  expect(w.calls).not.toContain('wait');
});

it('refuses a run answer that lands after a sweep removed its container as unavailable', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(C));
  await state.handle(op('start', ID));
  const release = hold(w, 'wait');
  const waited = state.handle(op('wait', ID));
  await settle();
  w.answer.delete = 500;
  await state.handle(op('delete', ID));
  expect(heldId(w)).toBeNull();
  release();
  expect(await waited).toEqual(UNAVAILABLE);
});

it('keeps the deadline once reached when the clock steps back: kills, refuses a start, runs late', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(C));
  await state.handle(op('start', ID));
  w.answer.kill = 500;
  const deadline = T0 + S1_WALL;
  w.now = deadline;
  w.calls.length = 0;
  await state.tick();
  w.now = deadline - 60_000;
  await state.tick();
  expect([w.calls, heldId(w)]).toEqual([['kill', 'kill'], ID]);
  expect(await state.handle(op('start', ID))).toEqual(refused('deadline'));
  await state.handle(op('wait', ID));
  expect(candidateOf(w)?.runs).toEqual([{ statusCode: 0, inTime: false }]);
});
