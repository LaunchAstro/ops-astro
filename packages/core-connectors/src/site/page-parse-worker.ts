// SPDX-License-Identifier: AGPL-3.0-only
//
// One check's parse, in a worker of its own (`page-parse.ts`): Astro's
// compiler reads the page before and after the edit and posts both trees.
// Its WebAssembly memory ends with the worker, and so does any fault in it.

import { parse } from '@astrojs/compiler/sync';
import { parentPort, workerData } from 'node:worker_threads';

const { before, after } = workerData as { readonly before: string; readonly after: string };
const read = {
  before: parse(before, { position: true }).ast,
  after: parse(after, { position: false }).ast,
};
parentPort?.postMessage(read, []);
