// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

it('a direct state-changing request in the app entry fails parity', async () => {
  const path = '../../scripts/command-parity.mjs';
  const { run } = await import(/* @vite-ignore */ path);
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
