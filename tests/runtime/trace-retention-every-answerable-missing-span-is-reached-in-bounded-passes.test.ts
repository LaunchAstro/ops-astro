// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#963, Sol PRV-oa-963-R3.1, the class; security re-read
// of 6e6b1b3, M1): owed runs' sent spans, newest first, are read pass after
// pass in `owedAsks`' order (oldest turn, unanswered, run id), each from
// where its last read stopped. The store answers `allowance` reads a pass
// and unknown after, and never answers for some spans. Run R has a missing
// block at place m, under up to four such spans just newer than it. Alone,
// R must be found gone within m + 1 passes (each pass moves its read on at
// least one span and never past a span the store would answer), and within
// ceil((m + 1) / allowance) when every span answers. With a run B always
// present, B's id before or after R's and B's reads spending the allowance
// first, R must be found within 2(m + 1) + 2 passes: a run the pass left
// with nothing answered keeps its turn and its place, and goes first next.

import { expect, it } from 'vitest';
import {
  freshReading,
  readBack,
  unsettled,
  type ExpiryPorts,
  type Reading,
} from '../../packages/core-runtime/src/trace-store.ts';
import { derivedId } from '../../packages/core-runtime/src/index.ts';

const KEY = Buffer.alloc(32, 7);
const BUSINESS = '00000000-0000-4000-8000-000000000001';
const R = '00000000-0000-4000-8000-00000000000b';

interface Run {
  readonly id: string;
  readonly length: number;
  readonly missing: readonly number[];
  readonly silent: readonly number[];
}

interface World {
  readonly allowance: number;
  readonly runs: readonly Run[];
  readonly bound: number;
}

interface Turn {
  turn: number;
  answered: boolean;
  resume: string | null;
}

const spansOf = (run: Run): string[] =>
  Array.from({ length: run.length }, (_, at) => `${run.id}/${String(at)}`);

function store(world: World): { readonly ports: ExpiryPorts; readonly pass: () => void } {
  const place = new Map<string, { run: Run; at: number }>();
  for (const run of world.runs) {
    for (const [at, id] of spansOf(run).entries()) {
      place.set(derivedId(KEY, ['span', BUSINESS, id], 16), { run, at });
    }
  }
  let used = 0;
  return {
    pass: () => {
      used = 0;
    },
    ports: {
      expire: () => Promise.resolve({ ok: true, status: 200, body: '' }),
      present: (_trace, spanId) => {
        used += 1;
        const span = place.get(spanId ?? '');
        if (span === undefined || used > world.allowance || span.run.silent.includes(span.at)) {
          return Promise.resolve('unknown');
        }
        return Promise.resolve(span.run.missing.includes(span.at) ? 'absent' : 'present');
      },
    },
  };
}

/** The runs in `owedAsks`' order: oldest turn, unanswered before answered, run id. */
const ordered = (turns: Map<string, Turn>): string[] =>
  [...turns.entries()]
    .toSorted(
      ([a, x], [b, y]) =>
        x.turn - y.turn || Number(x.answered) - Number(y.answered) || a.localeCompare(b),
    )
    .map(([id]) => id);

/** Records a pass as its batch row would: the runs it read, and where each unanswered one stopped. */
function record(turns: Map<string, Turn>, reading: Reading, pass: number): void {
  if (!unsettled(reading)) return;
  for (const id of reading.answered) turns.set(id, { turn: pass, answered: true, resume: null });
  for (const [at, id] of reading.unanswered.entries()) {
    turns.set(id, { turn: pass, answered: false, resume: reading.resumes[at] ?? null });
  }
}

/** The pass that finds R gone, or null within the world's bound. */
async function passesToGone(world: World): Promise<number | null> {
  const { ports, pass } = store(world);
  const turns = new Map(
    world.runs.map((run): [string, Turn] => [run.id, { turn: -1, answered: false, resume: null }]),
  );
  for (let round = 1; round <= world.bound; round += 1) {
    pass();
    const reading = freshReading();
    for (const run of world.runs) reading.sent.set(run.id, spansOf(run));
    for (const [id, turn] of turns) if (turn.resume !== null) reading.resume.set(id, turn.resume);
    // eslint-disable-next-line no-await-in-loop -- one pass after another
    const gone = await readBack(KEY, BUSINESS, ports, ordered(turns), reading);
    if (gone.includes(R)) return round;
    record(turns, reading, round);
  }
  return null;
}

/** Each missing block of R's of up to `sizes` spans at place m, under up to `quiet` silent spans just newer. */
function* targets(length: number, sizes: number, quiet: number): Generator<Run> {
  for (let size = 1; size <= sizes; size += 1) {
    for (let m = 0; m + size <= length; m += 1) {
      const missing = Array.from({ length: size }, (_, at) => m + at);
      for (let q = 0; q <= Math.min(quiet, m); q += 1) {
        yield { id: R, length, missing, silent: Array.from({ length: q }, (_, at) => m - q + at) };
      }
    }
  }
}

/** B, always present, before or after R by id: `allowance - 1` to `allowance + 2` spans, its last silent or not. */
function* others(allowance: number): Generator<Run> {
  for (const id of [
    '00000000-0000-4000-8000-00000000000a',
    '00000000-0000-4000-8000-00000000000c',
  ]) {
    for (let length = Math.max(1, allowance - 1); length <= allowance + 2; length += 1) {
      for (const silent of [[], [length - 1]]) yield { id, length, missing: [], silent };
    }
  }
}

function* worlds(): Generator<World> {
  for (let allowance = 1; allowance <= 5; allowance += 1) {
    for (let length = 1; length <= 12; length += 1) {
      for (const run of targets(length, 3, 4)) {
        const m = run.missing[0] ?? 0;
        const bound = run.silent.length === 0 ? Math.ceil((m + 1) / allowance) : m + 1;
        yield { allowance, runs: [run], bound };
      }
    }
    for (let length = 1; length <= 8; length += 1) {
      for (const run of targets(length, 2, 1)) {
        const bound = 2 * ((run.missing[0] ?? 0) + 1) + 2;
        for (const other of others(allowance)) yield { allowance, runs: [run, other], bound };
      }
    }
  }
}

it('Trace retention: every answerable missing span is reached in bounded passes', async () => {
  const late: string[] = [];
  for (const world of worlds()) {
    // eslint-disable-next-line no-await-in-loop -- one world after another
    if ((await passesToGone(world)) === null) late.push(JSON.stringify(world));
  }
  expect(late.slice(0, 5), `${String(late.length)} worlds not found within their bound`).toEqual(
    [],
  );
}, 60_000);
