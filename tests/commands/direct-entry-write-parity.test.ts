// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const PARITY = '../../scripts/command-parity.mjs';
// Loaded here, not in the test: loading probes every API route, about 4-6 s (#2467).
const { run } = (await import(
  /* @vite-ignore */
  PARITY
)) as { run: (files: Map<string, string>) => { failures: string[] } };

// Parses every web source twice, about 2.5 s at load 70, so it names its own timeout (#2467).
it('a direct state-changing request in the app entry fails parity', { timeout: 30_000 }, () => {
  const root = join(process.cwd(), 'apps/web/src');
  const files = new Map(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(root, file), readFileSync(file, 'utf8')];
      }),
  );
  expect(run(files).failures).toEqual([]);
  const entry = files.get('main.tsx');
  if (entry === undefined) throw new Error('app entry is missing');
  files.set(
    'main.tsx',
    `${entry}\nvoid fetch('/api/b/alpha/uncatalogued-write', { method: 'POST' });\n`,
  );
  expect(run(files).failures).not.toEqual([]);
});
