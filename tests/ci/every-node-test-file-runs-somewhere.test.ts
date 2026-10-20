// SPDX-License-Identifier: AGPL-3.0-only
//
// Vitest reads only .test.ts and .test.tsx, so a node:test file runs only
// when a package script or a workflow names it. Every tests/**/*.test.mjs file
// is named by one.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

describe('node:test files', () => {
  it('each runs under a package script or a workflow', () => {
    const scripts = Object.values(
      (
        JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>;
        }
      ).scripts,
    ).join('\n');
    const workflows = readdirSync(resolve(ROOT, '.github/workflows'))
      .map((file) => readFileSync(resolve(ROOT, '.github/workflows', file), 'utf8'))
      .join('\n');
    const files = execFileSync('git', ['ls-files', 'tests/**/*.test.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(
      files.filter((file) => !scripts.includes(file) && !workflows.includes(file)),
    ).toStrictEqual([]);
  });
});
