// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('a comment quoting the sign-in request does not fail parity', async () => {
  const path = '../../scripts/command-parity.mjs';
  const { run } = await import(/* @vite-ignore */ path);
  const entry = readFileSync('apps/web/src/main.tsx', 'utf8');
  const files = new Map([['main.tsx', entry]]);
  expect(run(files).failures).toEqual([]);
  files.set('main.tsx', `// window.fetch('/api/sign-in')\n${entry}`);
  expect(run(files).failures).toEqual([]);
});
