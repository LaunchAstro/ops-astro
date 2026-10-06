// SPDX-License-Identifier: AGPL-3.0-only
//
// P4, P6, I4 and B8 (docs/plan/sandbox-contract.md, sections 4 and 6): run
// operations take only the recorded id. The proxy sweeps on start before it
// takes a request, kills a container at its deadline and deletes it 30 s
// after the later of its wait and attach ending, 30 s after the launcher
// closes its attach before the wait, and at the latest 30 s after the
// deadline. An id leaves the record only on a delete answered success or
// "no such container"; any other answer starts a sweep. A failed sweep
// leaves every request `unavailable` and repeats every 30 s until one
// passes, and a run whose container a sweep removed is refused
// `unavailable`. A candidate's waits are recorded, and its id is accepted
// once its three counted runs each exited 0 before the deadline. Every case
// runs against the fixture's doubles, not a real daemon.

import { expect, it } from 'vitest';
import { recordContainer } from '../../packages/core-sandbox/src/container-book.ts';
import {
  C,
  candidateOf,
  containerId,
  create,
  GRACE,
  heldId,
  op,
  opened,
  P,
  pinList,
  pinnedEntry,
  refused,
  S1_WALL,
  s1,
  seeded,
  SITES,
  T0,
  UNAVAILABLE,
  world,
} from './proxy-state-fixture.ts';

const ID = containerId(1);
const CREATED = { ok: true, reply: expect.objectContaining({ status: 201 }) };

it('sweeps on start before it takes a request, recorded containers and strays alike', async () => {
  const stray = 'd'.repeat(64);
  const recorded = recordContainer({ container: null }, ID, T0, S1_WALL, false);
  const w = world(seeded(recorded));
  w.held.add(ID).add(stray);
  const state = await opened(w);
  expect(w.calls).toEqual(['list', 'remove', 'remove', 'list', 'info']);
  expect(w.held.size).toBe(0);
  expect(heldId(w)).toBeNull();
  expect(await state.handle(op('start', ID))).toEqual(UNAVAILABLE);
  expect(await state.handle(op('start', stray))).toEqual(refused('container id'));
});

it('takes a run operation only for the recorded full id', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  expect(await state.handle(op('start', ID))).toEqual({ ok: true, reply: expect.anything() });
  expect(await state.handle(op('start', 'e'.repeat(64)))).toEqual(refused('container id'));
  expect(
    await state.handle({ kind: 'attach', id: ID.slice(1).padEnd(64, 'e'), bodyStart: 0 }),
  ).toEqual(refused('container id'));
});

it('kills at the deadline, once, and deletes 30 s after it', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.calls.length = 0;
  w.now = T0 + S1_WALL - 1;
  await state.tick();
  expect(w.calls).toEqual([]);
  w.now = T0 + S1_WALL;
  w.killStatus = 409;
  await state.tick();
  await state.tick();
  expect(w.calls).toEqual(['kill']);
  w.now += GRACE;
  await state.tick();
  expect(w.calls).toEqual(['kill', 'delete']);
  expect(heldId(w)).toBeNull();
  expect(await state.handle(create(P, s1('p')))).toEqual(CREATED);
});

it('deletes 30 s after the launcher closes its attach before the wait', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.now = T0 + 1000;
  await state.attachClosed(ID);
  w.now += GRACE - 1;
  await state.tick();
  expect(heldId(w)).toBe(ID);
  w.now += 1;
  await state.tick();
  expect(heldId(w)).toBeNull();
});

it('starts a sweep when its own delete is answered 500, and the next create passes', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.deleteStatus = 500;
  w.now = T0 + S1_WALL + GRACE;
  w.calls.length = 0;
  await state.tick();
  expect(w.calls).toEqual(['kill', 'delete', 'list', 'remove', 'list', 'info']);
  expect(heldId(w)).toBeNull();
  expect(await state.handle(create(P, s1('p')))).toEqual(CREATED);
});

it('clears the record on a launcher delete answered "no such container", and keeps it on 409', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.held.clear();
  expect(await state.handle(op('delete', ID))).toEqual({ ok: true, reply: expect.anything() });
  expect(heldId(w)).toBeNull();
  await state.handle(create(P, s1('p')));
  const second = containerId(2);
  w.deleteStatus = 409;
  w.listBroken = true;
  await state.handle(op('delete', second));
  expect(heldId(w)).toBe(second);
  expect(await state.handle(op('start', second))).toEqual(UNAVAILABLE);
});

it('leaves every request unavailable while its sweep fails, and sweeps again every 30 s', async () => {
  const w = world();
  w.listBroken = true;
  const state = await opened(w);
  expect(await state.handle({ kind: 'ping' })).toEqual(UNAVAILABLE);
  expect(await state.handle(create(P, s1('p')))).toEqual(UNAVAILABLE);
  w.listBroken = false;
  w.calls.length = 0;
  w.now = T0 + GRACE - 1;
  await state.tick();
  expect(w.calls).toEqual([]);
  w.now = T0 + GRACE;
  await state.tick();
  expect(w.calls).toEqual(['list', 'list', 'info']);
  expect(await state.handle({ kind: 'ping' })).toEqual({ ok: true, reply: expect.anything() });
});

it('refuses a run whose container a sweep removed as unavailable', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.deleteStatus = 500;
  w.now = T0 + S1_WALL + GRACE;
  await state.tick();
  expect(await state.handle(op('wait', ID))).toEqual(UNAVAILABLE);
  expect(w.calls).not.toContain('wait');
});

/** C's three counted runs, each waited with `code` at `late` ms past its deadline (or before). */
async function runC(code: number, late = -1) {
  const w = world();
  const state = await opened(w);
  w.waitCode = code;
  const counted = async (n: number) => {
    w.now = T0 + n * 1_000_000;
    await state.handle(create(C));
    w.now += S1_WALL + late;
    await state.handle(op('wait', containerId(n)));
    await state.handle(op('delete', containerId(n)));
  };
  await counted(1);
  await counted(2);
  await counted(3);
  w.pins = pinList({ ...SITES, s: { ...pinnedEntry(C, 's') } });
  return { w, state };
}

it('records each counted wait and accepts C only after three zero exits in time', async () => {
  const { w, state } = await runC(0);
  expect(candidateOf(w)?.runs).toEqual(
    [0, 0, 0].map((statusCode) => ({ statusCode, inTime: true })),
  );
  expect(await state.handle(create(C, s1('s')))).toEqual(CREATED);
  const restarted = await opened(w);
  expect(await restarted.handle(create(C, s1('s')))).toEqual(CREATED);
});

it('does not accept C when a run exits non-zero or its wait returns at the deadline', async () => {
  const runs = [runC(1), runC(0, 0)].map(async (ran) =>
    (await ran).state.handle(create(C, s1('s'))),
  );
  expect(await Promise.all(runs)).toEqual([refused('candidate'), refused('candidate')]);
});
