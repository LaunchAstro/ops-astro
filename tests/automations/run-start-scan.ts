// SPDX-License-Identifier: AGPL-3.0-only
//
// The C52-A no-route scan's reading of the source tree (c52a-run-start): every
// app and package file, the run start's three names, and the files that
// define or re-export them.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every source file under `root`, skipping installed and built output. */
export function sourcesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory())
      return /^(node_modules|dist|\.astro)$/u.test(entry.name) ? [] : sourcesUnder(path);
    return /\.(ts|tsx|mts|mjs|js|cjs|astro|svelte)$/u.test(entry.name) ? [path] : [];
  });
}

/** Source text without comments, string literals, imports and re-exports. */
export const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '')
    .replaceAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu, "''")
    .replaceAll(/^(?:import|export)\b[^;]*?\bfrom\s+'';/gmsu, '');

export const RUN_START: RegExp =
  /\b(occurrenceRunStarter|dispatchOccurrence|startOccurrenceRun)\b/u;
// The two defining files, the third's own module, and the barrels that
// re-export each by its own name; the worker is the one caller allowed.
export const DEFINING: ReadonlySet<string> = new Set([
  'packages/core-commands/src/commands/automation-run.ts',
  'packages/core-commands/src/commands/occurrence-run.ts',
  'packages/core-records/src/automations/dispatch.ts',
  'packages/core-commands/src/index.ts',
  'packages/core-records/src/automations/index.ts',
]);
