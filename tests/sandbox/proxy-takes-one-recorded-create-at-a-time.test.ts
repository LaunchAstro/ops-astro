// SPDX-License-Identifier: AGPL-3.0-only
//
// P3 and B7 (docs/plan/sandbox-contract.md, section 6): the proxy takes one
// create at a time, from its count check until the returned id is durable
// in its record. A create's image is one the pin list holds for that class,
// bound to the entry whose `Env` the body carries, or, for the S1 body only,
// the open candidate of a pin being made. Before each create the record must
// be empty and the daemon's count zero; a count that differs refuses the
// create and starts a sweep. A candidate create is counted in the same
// durable write that records its container, so a create the daemon made but
// the proxy never recorded leaves its creates left unchanged. Both books sit
// in one file, read back as a closed grammar. Every case runs against the
// fixture's doubles, not a real daemon.

import { expect, it } from 'vitest';
import {
  EMPTY_CONTAINERS,
  recordContainer,
} from '../../packages/core-sandbox/src/container-book.ts';
import { readProxyRecord, writeProxyRecord } from '../../packages/core-sandbox/src/proxy-record.ts';
import { ProxyState } from '../../packages/core-sandbox/src/proxy-state.ts';
import {
  BASE,
  C,
  candidateOf,
  containerId,
  create,
  heldId,
  hold,
  op,
  opened,
  P,
  pinList,
  pinnedEntry,
  PROBE,
  ports,
  record,
  refused,
  S2,
  s1,
  seeded,
  seededBook,
  SITES,
  world,
} from './proxy-state-fixture.ts';

const CREATED = { ok: true, reply: expect.objectContaining({ status: 201 }) };

it('records a pinned create in the write before it answers, and does not count it', async () => {
  const w = world();
  const state = await opened(w);
  const answer = await state.handle(create(P, s1('p')));
  expect(answer).toEqual(CREATED);
  expect(heldId(w)).toBe(containerId(1));
  expect(candidateOf(w)?.createsLeft).toBe(3);
  expect(record(w).containers.container?.deadline).toBe(w.now + 120_000);
});

it('takes a create only for an image the pin list holds for its class and entry', async () => {
  const w = world();
  const state = await opened(w);
  const passes = async (step: ReturnType<typeof create>) => {
    const answer = await state.handle(step);
    await state.handle(op('delete', heldId(w) ?? ''));
    return answer.ok;
  };
  expect(await passes(create(BASE, S2))).toBe(true);
  expect(
    await passes(create(PROBE, { runClass: 'probe', probed: 'site.build', env: s1('p').env })),
  ).toBe(true);
  // P with site s's Env, P as the base, and the base in an S1 body name no entry.
  expect(await state.handle(create(P, s1('s')))).toEqual(refused('candidate'));
  expect(await state.handle(create(P, S2))).toEqual(refused('image id'));
  expect(await state.handle(create(BASE, s1('p')))).toEqual(refused('candidate'));
  // The base with its own Env in an S1 body is still not an S1 image.
  const crossed = { runClass: 'site.build', env: S2.env } as const;
  expect(await state.handle(create(BASE, crossed))).toEqual(refused('candidate'));
  expect(
    await state.handle(create(P, { runClass: 'probe', probed: 'site.build', env: [] })),
  ).toEqual(refused('image id'));
  expect(w.calls.filter((call) => call === 'create')).toHaveLength(2);
});

it('treats a deployed site id the proxy never accepted as no image id', async () => {
  const w = world(
    writeProxyRecord({
      candidates: { ...seededBook(), accepted: [] },
      containers: EMPTY_CONTAINERS,
    }),
  );
  const state = await opened(w);
  expect(await state.handle(create(P, s1('p')))).toEqual(refused('candidate'));
  expect(w.calls).not.toContain('create');
});

it('counts a candidate create in the write that records its container, three times only', async () => {
  const w = world();
  const state = await opened(w);
  const counted = async (n: number) => {
    expect(await state.handle(create(C))).toEqual(CREATED);
    expect(heldId(w)).toBe(containerId(n));
    expect(candidateOf(w)?.createsLeft).toBe(3 - n);
    await state.handle(op('delete', containerId(n)));
  };
  await counted(1);
  await counted(2);
  await counted(3);
  expect(await state.handle(create(C))).toEqual(refused('candidate'));
  expect(await state.handle(create(C, s1('p')))).toEqual(refused('candidate'));
});

it('leaves creates left unchanged when the store dies between the daemon create and its write', async () => {
  const w = world();
  const state = await opened(w);
  w.crashAfterCreate = true;
  expect(await state.handle(create(C))).toEqual({
    ok: false,
    reason: 'internal',
    why: 'reply status',
  });
  expect(w.held.size).toBe(1);
  w.crash = false;
  w.crashAfterCreate = false;
  const restarted = await opened(w);
  expect(w.held.size).toBe(0);
  expect(candidateOf(w)?.createsLeft).toBe(3);
  expect(await restarted.handle(create(C))).toEqual(CREATED);
  expect(candidateOf(w)?.createsLeft).toBe(2);
});

it('refuses a second create while the record holds a container, even one sent at once', async () => {
  const w = world();
  const state = await opened(w);
  const release = hold(w, 'create');
  const first = state.handle(create(P, s1('p')));
  const second = state.handle(create(P, s1('p')));
  release();
  expect(await first).toEqual(CREATED);
  expect(await second).toEqual(refused('container record'));
  expect(await state.handle(create(BASE, S2))).toEqual(refused('container record'));
  expect(w.calls.filter((call) => call === 'create')).toHaveLength(1);
  expect(w.held.size).toBe(1);
});

it('sweeps when the daemon lost the recorded container, and the next create passes', async () => {
  const w = world();
  const state = await opened(w);
  await state.handle(create(P, s1('p')));
  w.held.clear();
  w.calls.length = 0;
  expect(await state.handle(create(P, s1('p')))).toEqual(refused('container count'));
  expect([w.calls, heldId(w)]).toEqual([['info', 'list', 'list', 'info'], null]);
  expect(await state.handle(create(P, s1('p')))).toEqual(CREATED);
});

it('answers a create internal when its forward or its count check throws', async () => {
  const w = world();
  const state = await opened(w);
  const dropped = { ok: false, reason: 'internal', why: 'reply status' };
  w.throws.add('create');
  expect(await state.handle(create(P, s1('p')))).toEqual(dropped);
  w.throws.clear();
  w.throws.add('info');
  expect(await state.handle(create(P, s1('p')))).toEqual(dropped);
  w.throws.clear();
  expect([heldId(w), await state.handle(create(P, s1('p')))]).toEqual([null, CREATED]);
});

it('refuses a create when the daemon counts a container the record lacks, and sweeps it', async () => {
  const w = world();
  const state = await opened(w);
  w.held.add('d'.repeat(64));
  w.calls.length = 0;
  expect(await state.handle(create(P, s1('p')))).toEqual(refused('container count'));
  expect(w.calls).toEqual(['info', 'list', 'remove', 'list', 'info']);
  expect(await state.handle(create(P, s1('p')))).toEqual(CREATED);
});

it('passes a create the daemon refused with nothing recorded, and sweeps on an unreadable id', async () => {
  const w = world();
  const state = await opened(w);
  w.answer.create = 500;
  expect(await state.handle(create(C))).toEqual({
    ok: true,
    reply: expect.objectContaining({ status: 500 }),
  });
  expect([heldId(w), candidateOf(w)?.createsLeft]).toEqual([null, 3]);
  delete w.answer.create;
  w.badCreate = true;
  w.calls.length = 0;
  expect(await state.handle(create(C))).toEqual({
    ok: false,
    reason: 'internal',
    why: 'reply body',
  });
  expect(w.calls).toEqual(['info', 'create', 'list', 'remove', 'list', 'info']);
  expect([heldId(w), candidateOf(w)?.createsLeft, w.held.size]).toEqual([null, 3, 0]);
});

it('reads the daemon count only from a 200 answer', async () => {
  const w = world();
  const state = await opened(w);
  w.answer.info = 500;
  expect(await state.handle(create(P, s1('p')))).toEqual(refused('container count'));
  expect(w.calls).not.toContain('create');
});

it('admits no create from a pin list that breaks its grammar', async () => {
  const w = world();
  const state = await opened(w);
  w.pins = new TextEncoder().encode('{"probe":{}}');
  expect(await state.handle(create(P, s1('p')))).toEqual({
    ok: false,
    reason: 'internal',
    why: 'pin list',
  });
  expect(w.calls).not.toContain('create');
});

it('keeps an accepted id across a restart and drops it when the entry changes', async () => {
  const w = world();
  await opened(w);
  expect(record(w).candidates.accepted.map((pin) => pin.id)).toEqual([P]);
  w.pins = pinList({ ...SITES, p: pinnedEntry(P, 'p', 2) });
  const state = await opened(w);
  expect(record(w).candidates.accepted).toEqual([]);
  expect(await state.handle(create(P, s1('p')))).toEqual(refused('candidate'));
});

it('refuses a record the proxy could not have written', () => {
  const book = seededBook();
  const [held] = book.candidates;
  const [pin] = book.accepted;
  if (held === undefined || pin === undefined) throw new Error('no seed');
  const recorded = recordContainer(EMPTY_CONTAINERS, containerId(1), 5000, 1000, false);
  const broken = [
    { ...book, candidates: [held, { ...held, id: P }] },
    { ...book, candidates: [held, { ...held, site: 't' }] },
    { ...book, accepted: [pin, { ...pin, id: C }] },
    { ...book, accepted: [{ ...pin, attempt: 0 }] },
    {
      ...book,
      candidates: [{ ...held, createsLeft: 2, runs: [{ statusCode: null, inTime: true }] }],
    },
  ].map((candidates) => writeProxyRecord({ candidates, containers: EMPTY_CONTAINERS }));
  const { container } = recorded;
  if (container === null) throw new Error('no container');
  broken.push(
    writeProxyRecord({
      candidates: book,
      containers: { container: { ...container, deadline: 4999 } },
    }),
  );
  const bad = { ok: false, reason: 'internal', why: 'proxy record' };
  expect(broken.map((bytes) => readProxyRecord(bytes))).toEqual(broken.map(() => bad));
});

it('reads its one record file as a closed grammar', async () => {
  const book = writeProxyRecord({ candidates: seededBook(), containers: EMPTY_CONTAINERS });
  expect(readProxyRecord(book)).toEqual({
    ok: true,
    record: { candidates: seededBook(), containers: EMPTY_CONTAINERS },
  });
  const text = new TextDecoder().decode(book);
  const bad = { ok: false, reason: 'internal', why: 'proxy record' };
  for (const broken of [
    `{"extra":1,${text.slice(1)}`,
    text.replace('"containerBook"', '"containers"'),
    text.replace('"container":null', '"container":{}'),
    text.replace('"createsLeft":3', '"createsLeft":4'),
    `${text} `.repeat(2),
    '[]',
  ])
    expect(readProxyRecord(new TextEncoder().encode(broken))).toEqual(bad);
  const w = world(new TextEncoder().encode('{}'));
  expect(await ProxyState.open(ports(w))).toEqual(bad);
  expect(w.calls).toEqual([]);
  expect(seeded()).toEqual(book);
});
