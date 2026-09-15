// SPDX-License-Identifier: AGPL-3.0-only
// Check every selected commit, including the root when explicitly requested.
// Local commitlint and this range check share provenance parsing and validation.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { messageProvenanceErrors } from './provenance.mjs';

const base = process.env['BASE_SHA'];
const head = process.env['HEAD_SHA'];

if (base === undefined || head === undefined || base === '' || head === '') {
  console.error('commit-range: BASE_SHA and HEAD_SHA must both be set.');
  process.exit(2);
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

let range;
try {
  const mergeBase = git(['merge-base', base, head]).trim();
  range = `${mergeBase}..${head}`;
} catch {
  // No common ancestor: check everything reachable from head. This is the
  // first-push case, where the base is the empty tree.
  range = head;
}

// `rev-list a..b` excludes `a` itself. On a first push, where the base is the
// repository's own root commit, that means the root is never checked. Round
// four found it. HUB_RANGE_INCLUDE_ROOT=1 pulls it back in, which is what the
// publication receipt and the first-push case want.
const includeRoot = process.env['HUB_RANGE_INCLUDE_ROOT'] === '1';
const revListArgs = includeRoot && range.includes('..') ? [range.split('..')[1] ?? head] : [range];

const shas = git(['rev-list', ...revListArgs])
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

if (shas.length === 0) {
  console.log('commit-range: no commits in range; nothing to check.');
  process.exit(0);
}

console.log(`commit-range: ${shas.length} commit(s) in ${range}`);

const failures = [];

const repoRoot = resolve(import.meta.dirname, '..');
const commitlintBin = join(repoRoot, 'node_modules', '.bin', 'commitlint');
const commitlintConfig = join(repoRoot, 'commitlint.config.js');
const commitlintAvailable = existsSync(commitlintBin) && existsSync(commitlintConfig);
if (!commitlintAvailable && process.env['CI']) {
  console.error('commit-range: commitlint is required in CI; install the locked dependencies.');
  process.exit(2);
}
if (!commitlintAvailable) {
  console.log(
    'commit-range: commitlint unavailable; only the basic subject rule and provenance ran.',
  );
}

// The built-in rule, which also runs as a second opinion when commitlint is unavailable. Kept deliberately simple: it is a floor, not a replacement.
const TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'test'];
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9 ,._-]+\\))?!?: .+`, 'u');

// --- both rules, per commit -------------------------------------------------

for (const sha of shas) {
  const short = sha.slice(0, 9);
  const subject = git(['show', '-s', '--format=%s', sha]).trim();
  if (!commitlintAvailable && !SUBJECT.test(subject)) {
    failures.push(
      `${short} subject is not a conventional commit: ${JSON.stringify(subject)}\n` +
        `         expected one of ${TYPES.join(', ')} followed by ": " and a summary`,
    );
  }

  const message = git(['show', '-s', '--format=%B', sha]);
  if (commitlintAvailable) {
    try {
      execFileSync(commitlintBin, ['--config', commitlintConfig], {
        input: message,
        encoding: 'utf8',
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch {
      failures.push(`${short} commitlint rejected the message.`);
    }
  }
  for (const error of messageProvenanceErrors(message)) {
    failures.push(`${short} ${error}`);
  }
}

if (failures.length > 0) {
  console.error(`\ncommit-range: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    'commit-range: rewrite the messages on your branch rather than adding a\n' +
      'commit-range: commit to explain them. `git rebase -i` and `git commit --amend`\n' +
      'commit-range: are the tools; the trailers live in .gitmessage.',
  );
  process.exit(1);
}

console.log('commit-range: every commit carries a valid subject and its provenance.');
