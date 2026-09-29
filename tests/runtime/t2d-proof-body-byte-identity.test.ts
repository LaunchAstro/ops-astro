// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const title = 'a concurrent failure cannot leave a late effect on the settled attempt';

function proof(source: string): string {
  const titleAt = source.indexOf(title);
  if (titleAt < 0) throw new Error('T2d late-effect proof title is absent');
  const start = source.lastIndexOf('it(', titleAt);
  const ending = '}, 60_000);';
  const end = source.indexOf(ending, titleAt);
  if (start < 0 || end < 0) throw new Error('T2d late-effect proof body is absent');
  return source
    .slice(start, end + ending.length)
    .replace('Sol proof, criterion 2: ', '')
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n');
}

it('keeps the T2d late-effect proof body byte-identical after leading whitespace', () => {
  const approved = execFileSync(
    'git',
    ['show', '8fd5c64:tests/runtime/sol-t2d-review.test.ts'],
    { encoding: 'utf8' },
  );
  const replayed = readFileSync('tests/runtime/t2d-late-effect-and-wrong-client.test.ts', 'utf8');
  expect(proof(replayed)).toBe(proof(approved));
});
