// SPDX-License-Identifier: AGPL-3.0-only
//
// One check's compile, in a worker of its own (`page-transform.ts`): Astro's
// compiler parses the page before and after the edit, each source must run
// no code of its own (`page-source.ts`), and then the compiler prints both;
// the two modules are posted with their types blanked in place, offsets
// kept. A page that runs code, or a parse or compile that reports an error,
// posts nothing. Its WebAssembly memory ends with the worker, and so does
// any fault in it.

import { parse, transform } from '@astrojs/compiler';
import { stripTypeScriptTypes } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { runsNoCode } from './page-source.ts';

const { before, after, path } = workerData as {
  readonly before: string;
  readonly after: string;
  readonly path: string;
};

const isError = ({ severity }: { severity: number }) => severity === 1;

async function compiled(page: string): Promise<string | undefined> {
  const parsed = await parse(page);
  if (parsed.diagnostics.some(isError) || !runsNoCode(parsed.ast, path)) return undefined;
  // One fixed file name: the scope class the compiler adds hangs on it, not on the page.
  const result = await transform(page, { filename: 'page.astro' });
  if (result.diagnostics.some(isError)) return undefined;
  return stripTypeScriptTypes(result.code, { mode: 'strip' });
}

const [first, second] = [await compiled(before), await compiled(after)];
parentPort?.postMessage(
  first === undefined || second === undefined ? null : { before: first, after: second },
  [],
);
