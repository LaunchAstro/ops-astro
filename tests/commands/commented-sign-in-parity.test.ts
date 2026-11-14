// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const PARITY = '../../scripts/command-parity.mjs';
// Loaded here, not in the test: loading probes every API route, about 4-6 s (#2467).
const { run } = (await import(
  /* @vite-ignore */
  PARITY
)) as { run: (files: Map<string, string>) => { failures: string[] } };

it('a comment quoting the sign-in request does not fail parity', () => {
  const entry = readFileSync('apps/web/src/main.tsx', 'utf8');
  const files = new Map([['main.tsx', entry]]);
  expect(run(files).failures).toEqual([]);
  files.set('main.tsx', `// window.fetch('/api/sign-in')\n${entry}`);
  expect(run(files).failures).toEqual([]);
});
