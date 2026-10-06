// SPDX-License-Identifier: AGPL-3.0-only
//
// P3 and B8 (docs/plan/sandbox-contract.md, sections 4 and 6): a pin being
// made has a candidate, the image id the proxy computed at its load. The
// candidate is admitted for exactly three S1 creates of its own entry's
// body, F2's, and never past a deploy that changes the entry. The record is
// durable and survives a restart. A deployed site image id is taken only
// when it is the accepted one, or the candidate for that entry and attempt
// whose three counted runs each exited 0 before the deadline, under the
// lockfile digest it was loaded for; any other deployed id is no image id.

import { expect, it } from 'vitest';
import {
  admitCandidateLoad,
  candidateCreate,
  type CandidateBook,
  countCandidateCreate,
  dropCandidateImage,
  EMPTY_BOOK,
  holdsCandidateImage,
  readBook,
  readDeployed,
  recordCandidateWait,
  writeBook,
} from '../../packages/core-sandbox/src/candidate-book.ts';
import type { CreateShape } from '../../packages/core-sandbox/src/create-body.ts';
import type { SiteEntry } from '../../packages/core-sandbox/src/pin-list.ts';
import { S1_OPENING } from '../../packages/core-sandbox/src/run-env.ts';

const id = (c: string) => `sha256:${c.repeat(64)}`;
const C = id('c');
const D = id('d');
const LOCK = id('1');
/** A site's S1 `Env`: B3's fixed opening, then its own public variable. */
const env = (site: string) => [...S1_OPENING, `PUBLIC_SITE=${site}`];
const making = (attempt = 1, lockfile = LOCK, own = env('a')): SiteEntry => ({
  lockfile,
  image: '',
  attempt,
  commit: 'e'.repeat(40),
  env: own,
});
const pinned = (image: string, attempt = 1, lockfile = LOCK): SiteEntry => ({
  ...making(attempt, lockfile),
  image,
  commit: '',
});
const sites = (entries: Record<string, SiteEntry>): ReadonlyMap<string, SiteEntry> =>
  new Map(Object.entries(entries));
const s1 = (own: readonly string[] = env('a')): CreateShape => ({
  runClass: 'site.build',
  env: own,
});
const refused = { ok: false, reason: 'proxy refused', why: 'candidate' };

/** The book after C's load for site a, and the sites it was loaded under. */
function loaded(list = sites({ a: making() })): CandidateBook {
  const load = admitCandidateLoad(EMPTY_BOOK, list, 'a', C);
  if (!load.ok) throw new Error('load refused');
  return load.book;
}
/** C's book after `n` counted creates, each wait answered with `code`, in time or not. */
function ran(n: number, code = 0, inTime = true, book = loaded()): CandidateBook {
  let next = book;
  for (let run = 0; run < n; run += 1) {
    next = countCandidateCreate(next, C);
    next = recordCandidateWait(next, C, run, code, inTime);
  }
  return next;
}
const effective = (book: CandidateBook, list: ReadonlyMap<string, SiteEntry>) =>
  readDeployed(book, list).sites.get('a')?.image;

it('admits three S1 creates of the candidate and refuses the fourth', () => {
  const list = sites({ a: making() });
  let book = loaded(list);
  for (let run = 0; run < 3; run += 1) {
    expect(candidateCreate(book, list, s1(), C)).toEqual({ ok: true, site: 'a' });
    book = countCandidateCreate(book, C);
  }
  expect(candidateCreate(book, list, s1(), C)).toEqual(refused);
});

it('refuses a second load for the same entry and attempt, even once its creates are spent', () => {
  const list = sites({ a: making() });
  expect(admitCandidateLoad(loaded(list), list, 'a', C)).toEqual(refused);
  expect(admitCandidateLoad(loaded(list), list, 'a', D)).toEqual(refused);
  expect(admitCandidateLoad(ran(3), list, 'a', D)).toEqual(refused);
});

it("refuses the candidate under any body but its own entry's S1 body", () => {
  const list = sites({ a: making(), b: making(1, LOCK, env('b')) });
  const book = loaded(list);
  const s2: CreateShape = { runClass: 'site.prepare', env: env('a') };
  const probe: CreateShape = { runClass: 'probe', probed: 'site.build', env: env('a') };
  for (const shape of [s2, probe, s1(env('b'))])
    expect(candidateCreate(book, list, shape, C)).toEqual(refused);
  expect(candidateCreate(book, list, s1(), D)).toEqual(refused);
});

it('ends the admission when a deploy changes the entry', () => {
  const book = loaded();
  for (const changed of [
    making(2),
    making(1, id('2')),
    making(1, LOCK, env('z')),
    { ...making(), commit: 'f'.repeat(40) },
    pinned(C),
  ]) {
    const after = readDeployed(book, sites({ a: changed })).book;
    expect(candidateCreate(after, sites({ a: changed }), s1(changed.env), C)).toEqual(refused);
  }
  expect(candidateCreate(readDeployed(book, sites({})).book, sites({}), s1(), C)).toEqual(refused);
  const back = readDeployed(
    readDeployed(book, sites({ a: making(2) })).book,
    sites({ a: making() }),
  );
  expect(candidateCreate(back.book, back.sites, s1(), C)).toEqual(refused);
  expect(candidateCreate(book, sites({ a: making(2) }), s1(), C)).toEqual(refused);
});

it('refuses a load for an entry with an image id, an unknown site, or the id of an open candidate', () => {
  const list = sites({ a: making(), b: making(1, LOCK, env('b')), p: pinned(D) });
  expect(admitCandidateLoad(EMPTY_BOOK, list, 'p', C)).toEqual(refused);
  expect(admitCandidateLoad(EMPTY_BOOK, list, 'x', C)).toEqual(refused);
  expect(admitCandidateLoad(loaded(list), list, 'b', C)).toEqual(refused);
  const second = admitCandidateLoad(loaded(list), list, 'b', D);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(candidateCreate(second.book, list, s1(env('b')), D)).toEqual({ ok: true, site: 'b' });
  expect(candidateCreate(second.book, list, s1(), D)).toEqual(refused);
});

it('lets a raised attempt load again after a failed F2, and the old image be deleted', () => {
  const failed = ran(3, 1);
  const raised = sites({ a: making(2) });
  const book = readDeployed(failed, raised).book;
  const reload = admitCandidateLoad(book, raised, 'a', D);
  expect(reload.ok).toBe(true);
  if (!reload.ok) return;
  const unread = admitCandidateLoad(loaded(), raised, 'a', D);
  expect(unread.ok && readBook(writeBook(unread.book)).ok).toBe(true);
  expect(holdsCandidateImage(reload.book, C)).toBe(true);
  expect(holdsCandidateImage(dropCandidateImage(reload.book, C), C)).toBe(false);
  expect(holdsCandidateImage(dropCandidateImage(reload.book, D), D)).toBe(true);
});

it('refuses a reload of an attempt whose failed candidate image was deleted, or a lower one', () => {
  const list = sites({ a: making() });
  const back = readBook(writeBook(dropCandidateImage(ran(3, 1), C)));
  expect(back.ok).toBe(true);
  if (!back.ok) return;
  expect(admitCandidateLoad(back.book, list, 'a', C)).toEqual(refused);
  expect(candidateCreate(back.book, list, s1(), C)).toEqual(refused);
  const raised = sites({ a: making(2) });
  const reload = admitCandidateLoad(readDeployed(ran(3, 1), raised).book, raised, 'a', D);
  if (!reload.ok) throw new Error('load refused');
  expect(admitCandidateLoad(dropCandidateImage(reload.book, C), list, 'a', C)).toEqual(refused);
});

it('takes a deployed id only as the candidate whose three runs exited 0 in time', () => {
  const copied = sites({ a: pinned(C) });
  expect(effective(ran(3), copied)).toBe(C);
  expect(effective(ran(2), copied)).toBe('');
  expect(effective(loaded(), copied)).toBe('');
  expect(effective(ran(3, 1), copied)).toBe('');
  expect(effective(ran(3, 0, false), copied)).toBe('');
  expect(effective(ran(3), sites({ a: pinned(D) }))).toBe('');
  expect(effective(EMPTY_BOOK, copied)).toBe('');
  const ended = readDeployed(ran(2), sites({ a: making(1, LOCK, env('z')) })).book;
  expect(effective(ended, copied)).toBe('');
});

it('keeps an accepted id only while the entry keeps its id, lockfile digest and attempt', () => {
  const accepted = readDeployed(ran(3), sites({ a: pinned(C) })).book;
  expect(effective(accepted, sites({ a: pinned(C) }))).toBe(C);
  expect(effective(accepted, sites({ a: pinned(C, 1, id('2')) }))).toBe('');
  expect(effective(accepted, sites({ a: pinned(C, 2) }))).toBe('');
  const imageGone = dropCandidateImage(accepted, C);
  expect(effective(imageGone, sites({ a: pinned(C) }))).toBe(C);
  const emptied = readDeployed(imageGone, sites({ a: making() })).book;
  expect(effective(emptied, sites({ a: pinned(C) }))).toBe('');
  const changed = readDeployed(imageGone, sites({ a: pinned(D) })).book;
  expect(effective(changed, sites({ a: pinned(C) }))).toBe('');
  const raised = readDeployed(accepted, sites({ a: making(2) })).book;
  expect(effective(raised, sites({ a: pinned(C, 2) }))).toBe('');
});

it('reads the book back whole after a restart, and refuses any other shape', () => {
  const accepted = readDeployed(ran(3), sites({ a: pinned(C) })).book;
  const book = admitCandidateLoad(accepted, sites({ a: pinned(C), b: making() }), 'b', D);
  if (!book.ok) throw new Error('load refused');
  const back = readBook(writeBook(book.book));
  expect(back).toEqual({ ok: true, book: book.book });
  if (!back.ok) return;
  expect(effective(back.book, sites({ a: pinned(C) }))).toBe(C);
  const text = new TextDecoder().decode(writeBook(book.book));
  const bad = (edit: (value: string) => string) => readBook(new TextEncoder().encode(edit(text)));
  const fault = { ok: false, reason: 'internal', why: 'candidate record' };
  expect(bad((t) => t.replace('{"candidates"', '{"x":1,"candidates"'))).toEqual(fault);
  expect(bad((t) => t.replace('"createsLeft":3', '"createsLeft":4'))).toEqual(fault);
  expect(bad((t) => t.replace('"site":"b"', '"site":"B"'))).toEqual(fault);
  expect(bad((t) => t.replace(`"id":"${D}"`, '"id":"sha256:x"'))).toEqual(fault);
  expect(bad(() => '[]')).toEqual(fault);
  expect(bad((t) => t.replace('{"candidates"', '{"accepted":[],"candidates"'))).toEqual(fault);
});
