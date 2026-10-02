// SPDX-License-Identifier: AGPL-3.0-only

// MP-4-9a's test-first order and its named crossings, read from git and the
// suite's text. Kept out of the database conformance manifest on purpose: that
// job checks out one commit, so the history read here fails there, and the
// `local checks` job, which runs this file, has the full history.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('agent marks tests precede their implementation', () => {
  const firstTestCommit = execFileSync(
    'git',
    [
      'log',
      '--reverse',
      '--format=%H',
      '5cf315a9ea33feeffd739be8feb1096a07743ad0..HEAD',
      '--',
      'tests/commands/task-scores.test.ts',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')[0];
  expect(firstTestCommit).toBeTruthy();
  const firstVersion = execFileSync(
    'git',
    ['show', `${firstTestCommit}:tests/commands/task-scores.test.ts`],
    { encoding: 'utf8' },
  );
  expect(firstVersion.includes("it('sets the marks on its own picked-up task")).toBe(true);
  expect(firstVersion.includes("it('cannot reach a task outside its delegation")).toBe(true);
});

it('marks isolation names business, client and person crossings', () => {
  const suite = readFileSync('tests/commands/task-scores.test.ts', 'utf8');
  for (const boundary of ['business to business', 'client to client', 'person to person']) {
    expect(
      suite.includes(`MP-4-9a isolation: ${boundary}`),
      `no named marks-command test crosses ${boundary}`,
    ).toBe(true);
  }
});
