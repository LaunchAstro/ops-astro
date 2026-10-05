// SPDX-License-Identifier: AGPL-3.0-only
//
// One check's compile, in a worker of its own (`page-transform.ts`): Astro's
// compiler prints the page before and after the edit, and the two modules
// are posted with their types blanked in place, offsets kept. A compile
// that reports an error posts nothing. Its WebAssembly memory ends with the
// worker, and so does any fault in it.

import { transform } from '@astrojs/compiler';
import { stripTypeScriptTypes } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const { before, after } = workerData as { readonly before: string; readonly after: string };

async function compiled(page: string): Promise<string | undefined> {
  // One fixed file name: the scope class the compiler adds hangs on it, not on the page.
  const result = await transform(page, { filename: 'page.astro' });
  if (result.diagnostics.some(({ severity }) => severity === 1)) return undefined;
  return stripTypeScriptTypes(result.code, { mode: 'strip' });
}

const [first, second] = [await compiled(before), await compiled(after)];
parentPort?.postMessage(
  first === undefined || second === undefined ? null : { before: first, after: second },
  [],
);
