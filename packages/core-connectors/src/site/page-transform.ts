// SPDX-License-Identifier: AGPL-3.0-only
//
// Astro's compiler is WebAssembly whose memory only grows and whose fault
// can end the process hosting it from a timer (#781). So each check compiles
// in a fresh worker that is ended once it answers: its memory goes with it,
// and a fault, a hang past the deadline or an early exit is no answer.

import { Worker } from 'node:worker_threads';

export interface CompiledPages {
  /** Each page's compiled module, its types blanked in place. */
  readonly before: string;
  readonly after: string;
}

const COMPILER = new URL('./page-transform-worker.ts', import.meta.url);
const DEADLINE_MS = 10_000;

function isCompiled(value: unknown): value is CompiledPages {
  return (
    typeof value === 'object' &&
    value !== null &&
    'before' in value &&
    'after' in value &&
    typeof value.before === 'string' &&
    typeof value.after === 'string'
  );
}

/**
 * Both pages at `path` as the compiler prints them, or `undefined` when
 * either runs code of its own or the compiler gave no clean answer.
 */
export async function compiledApart(
  before: string,
  after: string,
  path: string,
): Promise<CompiledPages | undefined> {
  const worker = new Worker(COMPILER, { workerData: { before, after, path }, stderr: true });
  try {
    return await new Promise<CompiledPages | undefined>((settle) => {
      const end = (read?: unknown) => {
        clearTimeout(timer);
        settle(isCompiled(read) ? read : undefined);
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
