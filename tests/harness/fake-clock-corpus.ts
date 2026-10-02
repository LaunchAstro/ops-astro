// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: two of the harness test's four shared fakes (TEST.md 4.3,
// 4.4). Every entry, the baseline included, reads the same ones.
//
//   FP-C  the controlled clock. Deadlines, leases and any framework's own
//         scheduling read it; it moves only when the test moves it, so a
//         recovery case takes no wall-clock time.
//   FP-S  the source corpus: synthetic documents with stable identifiers,
//         revisions and digests, several times FP-M's declared window in
//         all and each one inside it, so the context step cannot be done in
//         one request and can be done in several. No client material.

import { createHash } from 'node:crypto';
import { REPLAY_MODEL_WINDOW } from '../../packages/core-connectors/src/index.ts';

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  /** Resolves once the clock reaches `at`; never on the wall clock. */
  until(at: number): Promise<void>;
}

export function fakeClock(start: number = Date.UTC(2026, 9, 1)): FakeClock {
  let now = start;
  const waiting: { readonly at: number; readonly wake: () => void }[] = [];
  return {
    now: () => now,
    advance: (ms) => {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('advance: a whole ms, forward');
      now += ms;
      for (const waiter of waiting.filter((entry) => entry.at <= now)) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.wake();
      }
    },
    until: async (at) => {
      if (at <= now) return;
      await new Promise<void>((wake) => {
        waiting.push({ at, wake });
      });
    },
  };
}

export interface CorpusDocument {
  readonly id: string;
  readonly revision: number;
  readonly body: string;
  readonly digest: string;
}

/** The corpus's size as a multiple of the window: several times it (TEST.md 5.1). */
export const CORPUS_WINDOWS = 4;
const DOCUMENTS = 16;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Deterministic synthetic text of exactly `bytes` ASCII bytes. */
function synthetic(id: string, bytes: number): string {
  const line = `${id}: synthetic page copy for the controlled correction, no client material. `;
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

/** FP-S: the same documents, ids, revisions and digests on every build. */
export function sourceCorpus(
  windowUnits: number = REPLAY_MODEL_WINDOW.contextUnits,
): CorpusDocument[] {
  const each = Math.ceil((windowUnits * CORPUS_WINDOWS) / DOCUMENTS);
  return Array.from({ length: DOCUMENTS }, (_, index) => {
    const id = `fp-s-${String(index + 1).padStart(3, '0')}`;
    const body = synthetic(id, each);
    return { id, revision: 1, body, digest: sha256(body) };
  });
}
