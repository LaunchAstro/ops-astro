// SPDX-License-Identifier: AGPL-3.0-only
//
// Astro's compiler is WebAssembly whose memory only grows and whose fault
// can end the process hosting it from a timer (#781). So each check parses
// in a fresh worker that is ended once it answers: its memory goes with it,
// and a fault, a hang past the deadline or an early exit is no answer.

import type { RootNode } from '@astrojs/compiler/types';
import { Worker } from 'node:worker_threads';

export interface ParsedPages {
  /** With source positions. */
  readonly before: RootNode;
  readonly after: RootNode;
}

const PARSER = new URL('./page-parse-worker.ts', import.meta.url);
const DEADLINE_MS = 10_000;

/** Both pages as the compiler reads them, or `undefined` when it gave no answer. */
export async function parsedApart(before: string, after: string): Promise<ParsedPages | undefined> {
  const worker = new Worker(PARSER, { workerData: { before, after } });
  try {
    return await new Promise<ParsedPages | undefined>((settle) => {
      const end = (read?: ParsedPages) => {
        clearTimeout(timer);
        settle(read);
      };
      const timer = setTimeout(end, DEADLINE_MS);
      worker.once('message', end);
      worker.once('error', () => {
        end();
      });
      worker.once('exit', () => {
        end();
      });
    });
  } finally {
    await worker.terminate();
  }
}
