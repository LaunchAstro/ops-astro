// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#963, Sol PRV-oa-963-R3.1, the class): one owed run's
// sent spans, newest first, are read pass after pass, each pass from where
// the last one's read stopped. The store answers `allowance` reads a pass and
// unknown after, and never answers for a block of spans newer than the
// missing ones. For every run length, allowance, missing block and such a
// block, the read must reach a missing span within m + 1 passes (m its
// place, newest first): each pass moves on at least one span and never past
// a span the store would answer. With every span answerable it must take no
// more than ceil((m + 1) / allowance) passes.

import { expect, it } from 'vitest';
import {
  readBack,
  type ExpiryPorts,
  type Reading,
} from '../../packages/core-runtime/src/trace-store.ts';
import { derivedId } from '../../packages/core-runtime/src/index.ts';

const KEY = Buffer.alloc(32, 7);
const BUSINESS = '00000000-0000-4000-8000-000000000001';
const RUN = '00000000-0000-4000-8000-000000000002';

interface World {
  readonly length: number;
  readonly allowance: number;
  readonly missing: readonly number[];
  readonly silent: readonly number[];
}

function store(world: World): { readonly ports: ExpiryPorts; readonly pass: () => void } {
  const place = new Map<string, number>();
  for (let at = 0; at < world.length; at += 1) {
    place.set(derivedId(KEY, ['span', BUSINESS, `e${String(at)}`], 16), at);
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
        const at = place.get(spanId ?? '') ?? -1;
        if (used > world.allowance || world.silent.includes(at)) return Promise.resolve('unknown');
        return Promise.resolve(world.missing.includes(at) ? 'absent' : 'present');
      },
    },
  };
}

/** The pass that finds the run gone, or null within `limit` passes. */
async function passesToGone(world: World, limit: number): Promise<number | null> {
  const sent = Array.from({ length: world.length }, (_, at) => `e${String(at)}`);
  const { ports, pass } = store(world);
  let resume: string | null = null;
  for (let round = 1; round <= limit; round += 1) {
    pass();
    const reading: Reading = {
      sent: new Map([[RUN, sent]]),
      resume: new Map(resume === null ? [] : [[RUN, resume]]),
      answered: [],
      unanswered: [],
      resumes: [],
      left: [],
      reads: 0,
      quiet: 0,
    };
    // eslint-disable-next-line no-await-in-loop -- one pass after another
    if ((await readBack(KEY, BUSINESS, ports, [RUN], reading)).length > 0) return round;
    resume = reading.resumes[0] ?? null;
  }
  return null;
}

/** Each missing block of 1..3 spans at place m, under 0..4 silent spans just newer than it. */
function* blocks(length: number): Generator<Pick<World, 'missing' | 'silent'>> {
  for (let size = 1; size <= 3; size += 1) {
    for (let m = 0; m + size <= length; m += 1) {
      const missing = Array.from({ length: size }, (_, at) => m + at);
      for (let quiet = 0; quiet <= Math.min(4, m); quiet += 1) {
        yield { missing, silent: Array.from({ length: quiet }, (_, at) => m - quiet + at) };
      }
    }
  }
}

function* worlds(): Generator<World> {
  for (let length = 1; length <= 12; length += 1) {
    for (let allowance = 1; allowance <= 5; allowance += 1) {
      for (const block of blocks(length)) yield { length, allowance, ...block };
    }
  }
}

it('Trace retention: every answerable missing span is reached in bounded passes', async () => {
  const late: string[] = [];
  for (const world of worlds()) {
    const m = world.missing[0] ?? 0;
    const bound = world.silent.length === 0 ? Math.ceil((m + 1) / world.allowance) : m + 1;
    // eslint-disable-next-line no-await-in-loop -- one world after another
    const found = await passesToGone(world, bound);
    if (found === null) late.push(JSON.stringify(world));
  }
  expect(late.slice(0, 5), `${String(late.length)} worlds not found within their bound`).toEqual(
    [],
  );
});
