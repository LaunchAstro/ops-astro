// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof on #2094 (S2094-3), body unchanged: the locate's search over a
// 40 KB line holding one word 8,000 times runs in a 128 MB heap.

import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('a repeated word on a 40KB page does not exhaust the runner heap', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=128',
      '--input-type=module',
      '-e',
      String.raw`
    import { replaced } from './packages/core-connectors/src/site/replaced.ts';
    const page = '<p>' + 'typo '.repeat(8000) + '</p>\n';
    const after = replaced.length === 4
      ? replaced('src/pages/about.astro', page, 'typo', 'fixed')
      : replaced(page, 'typo', 'fixed');
    if (after !== page.replace('typo', 'fixed')) process.exit(2);
  `,
    ],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  expect({
    status: child.status,
    signal: child.signal,
    error: child.error?.message,
    heapExhausted: child.stderr.includes('heap out of memory'),
  }).toEqual({
    status: 0,
    signal: null,
    error: undefined,
    heapExhausted: false,
  });
}, 15000);
