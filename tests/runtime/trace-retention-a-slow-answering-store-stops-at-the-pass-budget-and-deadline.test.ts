// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: a store that answers every read, however slowly, still
// cannot hold a pass. A pass makes at most READS_PER_PASS reads and starts
// none after its deadline, and a run it stopped goes on next pass from the
// span after the last one answered.

import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  freshReading,
  passBudget,
  readBack,
  READS_PER_PASS,
  type ExpiryPorts,
} from '../../packages/core-runtime/src/trace-store.ts';

const KEY = Buffer.alloc(32, 7);
const BUSINESS = '00000000-0000-4000-8000-000000000001';
const R = '00000000-0000-4000-8000-00000000000b';

/** A store that answers present to every read after `delayMs`, counting them. */
function answering(delayMs: number): { readonly ports: ExpiryPorts; readonly reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    ports: {
      expire: () => Promise.resolve({ ok: true, status: 200, body: '' }),
      present: async () => {
        reads += 1;
        if (delayMs > 0) await sleep(delayMs);
        return 'present';
      },
    },
  };
}

const spans = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `${R}/${String(at)}`);

it('Trace retention: a pass makes at most its budget of reads', async () => {
  const store = answering(0);
  const reading = freshReading();
  reading.sent.set(R, spans(READS_PER_PASS + 200));
  await readBack(KEY, BUSINESS, store.ports, [R], reading);
  expect(store.reads(), 'one pass reads no more than its budget').toBe(READS_PER_PASS);
  expect(reading.resumes, 'the run goes on after its last answered span').toEqual([
    `${R}/${String(READS_PER_PASS)}`,
  ]);
});

it('Trace retention: a slow store is read no further once the pass is past its deadline', async () => {
  const store = answering(40);
  const reading = freshReading(passBudget(READS_PER_PASS, Date.now() + 200));
  reading.sent.set(R, spans(100));
  await readBack(KEY, BUSINESS, store.ports, [R], reading);
  expect(store.reads(), 'no read starts after the deadline').toBeLessThanOrEqual(8);
  expect(reading.unanswered, 'the stopped run keeps its progress').toEqual([R]);
  expect(reading.resumes).toEqual([`${R}/${String(store.reads())}`]);
});
