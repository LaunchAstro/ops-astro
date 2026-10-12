// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: run R has 1,001 sent spans. The first 1,000 in reading
// order answer present and the last is missing. A pass's budget is 1,000
// reads, so the first pass stops with R's last span unread. The run keeps
// what it read: its resume, recorded with the pass, is the span after the
// last one answered, and the next pass reads that span alone and finds the
// run gone. Left where it began, it would read the same 1,000 spans every
// pass.

import { expect, it } from 'vitest';
import {
  freshReading,
  readBack,
  READS_PER_PASS,
  type ExpiryPorts,
} from '../../packages/core-runtime/src/trace-store.ts';
import { derivedId } from '../../packages/core-runtime/src/index.ts';

const KEY = Buffer.alloc(32, 7);
const BUSINESS = '00000000-0000-4000-8000-000000000001';
const R = '00000000-0000-4000-8000-00000000000b';

it('Trace retention: a run stopped by the budget resumes after its answered prefix', async () => {
  const sent = Array.from({ length: READS_PER_PASS + 1 }, (_, at) => `${R}/${String(at)}`);
  const last = sent.at(-1) ?? '';
  const missing = derivedId(KEY, ['span', BUSINESS, last], 16);
  const reads: string[] = [];
  const ports: ExpiryPorts = {
    expire: () => Promise.resolve({ ok: true, status: 200, body: '' }),
    present: (_trace, spanId) => {
      reads.push(spanId ?? '');
      return Promise.resolve(spanId === missing ? 'absent' : 'present');
    },
  };

  const first = freshReading();
  first.sent.set(R, sent);
  expect(await readBack(KEY, BUSINESS, ports, [R], first), 'nothing is gone yet').toEqual([]);
  expect(reads, 'the first pass spends its budget on the present prefix').toHaveLength(
    READS_PER_PASS,
  );
  expect(first.unanswered, 'the run is recorded with where it stopped').toEqual([R]);

  // The next pass, from what the first recorded.
  reads.length = 0;
  const next = freshReading();
  next.sent.set(R, sent);
  next.resume.set(R, first.resumes[0] ?? '');
  expect(await readBack(KEY, BUSINESS, ports, [R], next)).toEqual([R]);
  expect(reads, 'the next pass reads only the span after the answered prefix').toEqual([missing]);
});
