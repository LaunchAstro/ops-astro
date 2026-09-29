// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1d's command-line proof must run the command-line process helper for
// all three operations. This checks the proof itself because a product test
// cannot establish that another test used a separate OS process.

import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

function processProofNames(): readonly string[] {
  const names = new Set<string>();
  for (const relative of globSync('tests/**/*.test.ts', { cwd: ROOT })) {
    const source = readFileSync(join(ROOT, relative), 'utf8');
    if (!source.includes('cli-process-harness.ts')) continue;
    const call = /\brunCli\s*\(\s*\[\s*['"](inbox\.(?:read|count|seen))['"]/gu;
    for (const match of source.matchAll(call)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names].toSorted();
}

describe('INB-1d command-line process coverage', () => {
  it('Sol proof, criterion 38: inbox operations use the command-line process helper', () => {
    expect(processProofNames()).toStrictEqual(['inbox.count', 'inbox.read', 'inbox.seen']);
  });
});
