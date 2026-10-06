// SPDX-License-Identifier: AGPL-3.0-only
//
// P3 and B8 (docs/plan/sandbox-contract.md, sections 4 and 6): the proxy's
// durable candidate record. A pin being made (a site entry with a lockfile
// digest and no image id) has a candidate: the image id the proxy computed
// at its load. One load per entry and attempt; it admits exactly the reproducibility check's three
// S1 creates of that entry's own body, each counted in the write that
// records its container, and a deploy that changes the entry in any way
// ends the admission. An ended or superseded candidate stays until its
// image is deleted. A sweep never touches this record.
//
// On every read of the pin list, a site entry's id is taken only when it is
// the id the proxy accepted for that entry, lockfile digest and attempt, or
// it is that entry and attempt's candidate, loaded under the same lockfile
// digest, whose three counted runs each exited 0 before their deadline.
// Any other id reads as no image id. A changed or emptied entry clears its
// accepted id.
//
// The record is read back as text, so `readBook` is a closed reader: exact
// keys, the pin list's own entry grammar, and the counts that check allows.

import type { CreateShape } from './create-body.ts';
import { SITE_ID, type SiteEntry, siteEntry } from './pin-list.ts';
import { fault, refuse, type SandboxResult } from './refusal.ts';
import { hasExactKeys, isJsonObject, type Json, parseStrictJson } from './strict-json.ts';

export type CandidateRun = { readonly statusCode: number | null; readonly inTime: boolean };
export type Candidate = {
  readonly site: string;
  /** The entry as it was deployed at the load. */
  readonly entry: SiteEntry;
  readonly id: string;
  readonly createsLeft: number;
  /** One per counted create: its wait's `StatusCode` and whether it came before the deadline. */
  readonly runs: readonly CandidateRun[];
};
export type AcceptedPin = {
  readonly site: string;
  readonly id: string;
  readonly lockfile: string;
  readonly attempt: number;
};
export type CandidateBook = {
  readonly candidates: readonly Candidate[];
  readonly accepted: readonly AcceptedPin[];
};
type Sites = ReadonlyMap<string, SiteEntry>;

/** The reproducibility check's creates: a load admits its candidate for exactly this many. */
export const F2_CREATES = 3;
const IMAGE = /^sha256:[0-9a-f]{64}$/u;
const MAX_ATTEMPT = 2 ** 31 - 1;

export const EMPTY_BOOK: CandidateBook = { candidates: [], accepted: [] };

export const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, at) => item === b[at]);
const sameEntry = (a: SiteEntry, b: SiteEntry) =>
  a.lockfile === b.lockfile &&
  a.image === b.image &&
  a.attempt === b.attempt &&
  a.commit === b.commit &&
  sameList(a.env, b.env);
const isOpen = (candidate: Candidate) => candidate.createsLeft > 0;

export function admitCandidateLoad(
  book: CandidateBook,
  sites: Sites,
  site: string,
  id: string,
): SandboxResult<{ book: CandidateBook }> {
  const entry = sites.get(site);
  if (entry === undefined || entry.image !== '' || !IMAGE.test(id)) return refuse('candidate');
  const taken = book.candidates.some(
    (held) =>
      (held.site === site && held.entry.attempt === entry.attempt) ||
      (isOpen(held) && held.id === id),
  );
  if (taken) return refuse('candidate');
  const superseded = book.candidates.map((held) =>
    held.site === site ? { ...held, createsLeft: 0 } : held,
  );
  const loaded = { site, entry, id, createsLeft: F2_CREATES, runs: [] };
  return { ok: true, book: { ...book, candidates: [...superseded, loaded] } };
}

/** The site whose open candidate this create is, with that entry's own S1 body, else refused. */
export function candidateCreate(
  book: CandidateBook,
  sites: Sites,
  shape: CreateShape,
  image: string,
): SandboxResult<{ site: string }> {
  const held = book.candidates.find((candidate) => isOpen(candidate) && candidate.id === image);
  const entry = held === undefined ? undefined : sites.get(held.site);
  if (
    held === undefined ||
    entry === undefined ||
    !sameEntry(entry, held.entry) ||
    shape.runClass !== 'site.build' ||
    !sameList(shape.env, entry.env)
  )
    return refuse('candidate');
  return { ok: true, site: held.site };
}

/** One counted create of the open candidate `id`, for the write that records its container. */
export const countCandidateCreate = (book: CandidateBook, id: string): CandidateBook => ({
  ...book,
  candidates: book.candidates.map((held) =>
    isOpen(held) && held.id === id
      ? {
          ...held,
          createsLeft: held.createsLeft - 1,
          runs: [...held.runs, { statusCode: null, inTime: false }],
        }
      : held,
  ),
});

/** The wait of counted run `run` of the latest candidate `id`; only its first answer counts. */
export function recordCandidateWait(
  book: CandidateBook,
  id: string,
  run: number,
  statusCode: number,
  inTime: boolean,
): CandidateBook {
  const at = book.candidates.findLastIndex((held) => held.id === id);
  const held = book.candidates[at];
  if (held === undefined || held.runs[run]?.statusCode !== null) return book;
  const runs = held.runs.map((old, n) => (n === run ? { statusCode, inTime } : old));
  return { ...book, candidates: book.candidates.with(at, { ...held, runs }) };
}

const madeByF2 = (held: Candidate, site: string, entry: SiteEntry) =>
  held.site === site &&
  held.id === entry.image &&
  held.entry.attempt === entry.attempt &&
  held.entry.lockfile === entry.lockfile &&
  held.runs.length === F2_CREATES &&
  held.runs.every((run) => run.statusCode === 0 && run.inTime);

/** B8 on a read of the deployed site entries: the book after it, and each entry's usable id. */
export function readDeployed(
  book: CandidateBook,
  sites: Sites,
): { book: CandidateBook; sites: Sites } {
  const candidates = book.candidates.map((held) => {
    const entry = sites.get(held.site);
    return isOpen(held) && (entry === undefined || !sameEntry(entry, held.entry))
      ? { ...held, createsLeft: 0 }
      : held;
  });
  const accepted: AcceptedPin[] = [];
  const usable = new Map<string, SiteEntry>();
  for (const [site, entry] of sites) {
    const prior = book.accepted.find((pin) => pin.site === site);
    const kept =
      prior !== undefined &&
      prior.id === entry.image &&
      prior.lockfile === entry.lockfile &&
      prior.attempt === entry.attempt;
    const taken =
      entry.image !== '' && (kept || candidates.some((held) => madeByF2(held, site, entry)));
    if (taken) {
      const { lockfile, attempt } = entry;
      accepted.push({ site, id: entry.image, lockfile, attempt });
    }
    usable.set(site, taken || entry.image === '' ? entry : { ...entry, image: '' });
  }
  return { book: { candidates, accepted }, sites: usable };
}

export const holdsCandidateImage = (book: CandidateBook, id: string): boolean =>
  book.candidates.some((held) => held.id === id);

/** The book once image `id` is deleted: its ended candidates leave; an open one stays. */
export const dropCandidateImage = (book: CandidateBook, id: string): CandidateBook => ({
  ...book,
  candidates: book.candidates.filter((held) => isOpen(held) || held.id !== id),
});

/** The book as the JSON value its record holds. */
export const bookValue = (book: CandidateBook): Json => ({
  candidates: book.candidates.map(({ site, entry, id, createsLeft, runs }) => ({
    site,
    entry: { ...entry, env: [...entry.env] },
    id,
    createsLeft,
    runs: runs.map((run) => ({ ...run })),
  })),
  accepted: book.accepted.map((pin) => ({ ...pin })),
});

export const writeBook = (book: CandidateBook): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(bookValue(book)));

const isCount = (value: Json | undefined, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

function readRun(value: Json): CandidateRun | null {
  if (!hasExactKeys(value, ['statusCode', 'inTime']) || !isJsonObject(value)) return null;
  const { statusCode, inTime } = value;
  if (typeof inTime !== 'boolean') return null;
  if (statusCode === null) return inTime ? null : { statusCode, inTime };
  return isCount(statusCode, Number.MAX_SAFE_INTEGER) ? { statusCode, inTime } : null;
}

function readCandidate(value: Json): Candidate | null {
  const keys = ['site', 'entry', 'id', 'createsLeft', 'runs'];
  if (!hasExactKeys(value, keys) || !isJsonObject(value)) return null;
  const { site, id, createsLeft } = value;
  const entry = siteEntry(value['entry']);
  const listed = value['runs'];
  if (!Array.isArray(listed)) return null;
  const runs = listed.map((run) => readRun(run));
  if (
    typeof site !== 'string' ||
    !SITE_ID.test(site) ||
    entry === null ||
    entry.image !== '' ||
    typeof id !== 'string' ||
    !IMAGE.test(id) ||
    !isCount(createsLeft, F2_CREATES - runs.length) ||
    runs.some((run) => run === null)
  )
    return null;
  return { site, entry, id, createsLeft, runs: runs.filter((run) => run !== null) };
}

function readAccepted(value: Json): AcceptedPin | null {
  if (!hasExactKeys(value, ['site', 'id', 'lockfile', 'attempt']) || !isJsonObject(value))
    return null;
  const { site, id, lockfile, attempt } = value;
  const fits =
    typeof site === 'string' &&
    SITE_ID.test(site) &&
    typeof id === 'string' &&
    IMAGE.test(id) &&
    typeof lockfile === 'string' &&
    IMAGE.test(lockfile) &&
    isCount(attempt, MAX_ATTEMPT) &&
    attempt >= 1;
  return fits ? { site, id, lockfile, attempt } : null;
}

export function readBook(bytes: Uint8Array): SandboxResult<{ book: CandidateBook }> {
  const read = parseStrictJson(bytes);
  return read.ok ? bookOf(read.value) : fault('candidate record');
}

/** The book a parsed record holds, read as `readBook` reads its bytes. */
export function bookOf(value: Json): SandboxResult<{ book: CandidateBook }> {
  if (!hasExactKeys(value, ['candidates', 'accepted']) || !isJsonObject(value))
    return fault('candidate record');
  const { candidates: listed, accepted: pins } = value;
  if (!Array.isArray(listed) || !Array.isArray(pins)) return fault('candidate record');
  const candidates = listed.map((held) => readCandidate(held));
  const accepted = pins.map((pin) => readAccepted(pin));
  const open = candidates.filter((held) => held !== null && isOpen(held));
  if (
    candidates.some((held) => held === null) ||
    accepted.some((pin) => pin === null) ||
    new Set(open.map((held) => held?.site)).size !== open.length ||
    new Set(open.map((held) => held?.id)).size !== open.length ||
    new Set(accepted.map((pin) => pin?.site)).size !== accepted.length
  )
    return fault('candidate record');
  return {
    ok: true,
    book: {
      candidates: candidates.filter((held) => held !== null),
      accepted: accepted.filter((pin) => pin !== null),
    },
  };
}
