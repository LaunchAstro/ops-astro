// SPDX-License-Identifier: AGPL-3.0-only
//
// P3, P4 and P6 (docs/plan/sandbox-contract.md, section 6): the proxy holds
// at most one recorded container. A create needs an empty record and a
// daemon count of zero; a count that differs from the record refuses the
// create and starts a sweep. The run operations take only the recorded
// full id. The container's deadline runs from its durable create record,
// so a container never started has one too. The proxy kills it at the
// deadline (a kill refused as not running counts as landed) and deletes it
// 30 s after the later of its wait returning and its attach ending, 30 s
// after the launcher fully closes its attach before the wait returns, and
// at the latest 30 s after the deadline; a `wall` crossing's container not
// before then. An id leaves the record only on a delete answered success
// or "no such container"; any other answer keeps it and starts a sweep.

import { expect, it } from 'vitest';
import {
  admitContainerCreate,
  admitContainerOp,
  type ContainerBook,
  containerDue,
  deleteAnswered,
  EMPTY_CONTAINERS,
  GRACE_MS,
  killAnswered,
  noteAttachClosed,
  noteAttachEnded,
  noteWaitReturned,
  readContainerBook,
  recordContainer,
  writeContainerBook,
} from '../../packages/core-sandbox/src/container-book.ts';

const ID = 'a'.repeat(64);
const T0 = 1_000_000;
const WALL = 120_000;
const DEADLINE = T0 + WALL;
const held = (wall = false): ContainerBook => recordContainer(EMPTY_CONTAINERS, ID, T0, WALL, wall);
const none = { kill: false, delete: false };

it('takes a create only with an empty record and a daemon count of zero', () => {
  expect(admitContainerCreate(EMPTY_CONTAINERS, 0)).toEqual({ ok: true });
  expect(admitContainerCreate(held(), 1)).toEqual({
    ok: false,
    reason: 'proxy refused',
    why: 'container record',
  });
  expect(admitContainerCreate(EMPTY_CONTAINERS, 1)).toEqual({
    ok: false,
    reason: 'proxy refused',
    why: 'container count',
  });
});

it('takes a run operation only for the recorded full id', () => {
  expect(admitContainerOp(held(), ID)).toEqual({ ok: true });
  const refused = { ok: false, reason: 'proxy refused', why: 'container id' };
  for (const id of ['b'.repeat(64), ID.slice(0, 12)])
    expect(admitContainerOp(held(), id)).toEqual(refused);
  expect(admitContainerOp(EMPTY_CONTAINERS, ID)).toEqual(refused);
});

it('kills at the deadline from the create record, even if never started, and deletes 30 s after', () => {
  expect(containerDue(held(), DEADLINE - 1)).toEqual(none);
  expect(containerDue(held(), DEADLINE)).toEqual({ kill: true, delete: false });
  const killed = killAnswered(held(), 'not running');
  expect(containerDue(killed, DEADLINE)).toEqual(none);
  expect(containerDue(killed, DEADLINE + GRACE_MS - 1)).toEqual(none);
  expect(containerDue(killed, DEADLINE + GRACE_MS)).toEqual({ kill: false, delete: true });
  const unkilled = killAnswered(held(), 'failed');
  expect(containerDue(unkilled, DEADLINE + GRACE_MS)).toEqual({ kill: true, delete: true });
});

it('kills at the deadline even after a wait returned, until a kill lands', () => {
  const waited = noteWaitReturned(held(), T0 + 10_000);
  expect(containerDue(waited, DEADLINE)).toEqual({ kill: true, delete: false });
  expect(containerDue(killAnswered(waited, 'not running'), DEADLINE)).toEqual(none);
});

it('deletes 30 s after the later of the wait returning and the attach ending', () => {
  const waited = noteWaitReturned(held(), T0 + 10_000);
  expect(containerDue(waited, T0 + 50_000)).toEqual(none);
  const ended = noteAttachEnded(waited, T0 + 20_000);
  expect(containerDue(ended, T0 + 20_000 + GRACE_MS - 1)).toEqual(none);
  expect(containerDue(ended, T0 + 20_000 + GRACE_MS)).toEqual({ kill: false, delete: true });
  const reversed = noteWaitReturned(noteAttachEnded(held(), T0 + 5000), T0 + 15_000);
  expect(containerDue(reversed, T0 + 15_000 + GRACE_MS - 1)).toEqual(none);
  expect(containerDue(reversed, T0 + 15_000 + GRACE_MS).delete).toBe(true);
  const again = noteWaitReturned(ended, T0 + 40_000);
  expect(containerDue(again, T0 + 20_000 + GRACE_MS).delete).toBe(true);
  const late = noteAttachEnded(noteWaitReturned(held(), DEADLINE + 20_000), DEADLINE + 25_000);
  expect(containerDue(late, DEADLINE + GRACE_MS).delete).toBe(true);
});

it('deletes 30 s after a full close before the wait returns, not after one once it has', () => {
  const closed = noteAttachClosed(held(), T0 + 4000);
  expect(containerDue(closed, T0 + 4000 + GRACE_MS - 1)).toEqual(none);
  expect(containerDue(closed, T0 + 4000 + GRACE_MS)).toEqual({ kill: false, delete: true });
  const late = noteAttachClosed(noteWaitReturned(held(), T0 + 1000), T0 + 2000);
  expect(containerDue(late, T0 + 2000 + GRACE_MS).delete).toBe(false);
});

it("never deletes a wall crossing's container before 30 s after its deadline", () => {
  const ended = noteAttachEnded(noteWaitReturned(held(true), T0 + 1000), T0 + 1000);
  const closed = noteAttachClosed(held(true), T0 + 1000);
  for (const book of [ended, closed]) {
    expect(containerDue(book, DEADLINE + GRACE_MS - 1).delete).toBe(false);
    expect(containerDue(book, DEADLINE + GRACE_MS).delete).toBe(true);
  }
});

it('lets an id leave only on success or "no such container", else keeps it and sweeps', () => {
  expect(deleteAnswered(held(), 'removed')).toEqual({ book: EMPTY_CONTAINERS, sweep: false });
  expect(deleteAnswered(held(), 'no such container')).toEqual({
    book: EMPTY_CONTAINERS,
    sweep: false,
  });
  expect(deleteAnswered(held(), 'failed')).toEqual({ book: held(), sweep: true });
});

it('reads the record back whole after a restart, and refuses any other shape', () => {
  const book = noteAttachEnded(
    noteWaitReturned(killAnswered(held(true), 'landed'), T0 + 1),
    T0 + 2,
  );
  expect(readContainerBook(writeContainerBook(book))).toEqual({ ok: true, book });
  expect(readContainerBook(writeContainerBook(EMPTY_CONTAINERS))).toEqual({
    ok: true,
    book: EMPTY_CONTAINERS,
  });
  const text = new TextDecoder().decode(writeContainerBook(book));
  const bad = (edit: (value: string) => string) =>
    readContainerBook(new TextEncoder().encode(edit(text)));
  const fault = { ok: false, reason: 'internal', why: 'container record' };
  expect(bad((t) => t.replace(ID, ID.slice(1)))).toEqual(fault);
  expect(bad((t) => t.replace('"wall":true', '"wall":1'))).toEqual(fault);
  expect(bad((t) => t.replace('{"container"', '{"x":1,"container"'))).toEqual(fault);
  expect(bad((t) => t.replace(`"deadline":${String(DEADLINE)}`, '"deadline":-1'))).toEqual(fault);
  expect(bad((t) => t.replace(`"createdAt":${String(T0)}`, '"createdAt":-1'))).toEqual(fault);
});
