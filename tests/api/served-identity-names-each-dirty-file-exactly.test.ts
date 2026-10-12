// SPDX-License-Identifier: AGPL-3.0-only
//
// The served identity names each dirty tracked file as Git does: an unstaged
// edit (` M <path>`), a staged one (`M  <path>`) and both at once, in a
// throwaway repository, so the receipt never names a file nobody touched.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readIdentity } from '../../apps/api/identity.ts';

let checkout: string;

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });

beforeAll(() => {
  checkout = mkdtempSync(join(tmpdir(), 'served-identity-'));
  git('init', '--quiet');
  for (const name of ['pnpm-lock.yaml', 'staged.ts', 'both.ts', 'clean.ts']) {
    writeFileSync(join(checkout, name), 'first\n');
  }
  git('add', '.');
  git(
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
});

afterAll(() => {
  rmSync(checkout, { recursive: true, force: true });
});

describe('the served identity', () => {
  it('names an unstaged edit as the first dirty file by its whole path', () => {
    writeFileSync(join(checkout, 'pnpm-lock.yaml'), 'edited\n');
    expect(readIdentity(checkout).dirty).toStrictEqual(['pnpm-lock.yaml']);
  });

  it('names staged, unstaged and both-at-once edits by their whole paths', () => {
    writeFileSync(join(checkout, 'staged.ts'), 'edited\n');
    writeFileSync(join(checkout, 'both.ts'), 'edited\n');
    git('add', 'staged.ts', 'both.ts');
    writeFileSync(join(checkout, 'both.ts'), 'edited again\n');
    expect(readIdentity(checkout).dirty.toSorted()).toStrictEqual([
      'both.ts',
      'pnpm-lock.yaml',
      'staged.ts',
    ]);
  });
});
