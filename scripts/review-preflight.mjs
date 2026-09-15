// SPDX-License-Identifier: AGPL-3.0-only
// The checkpoint that has to happen before a review means anything.
//
// Finding 4 of the sweep of 6 September. The loop ran /code-review before
// committing, and /code-review inspects `git diff <base>...HEAD`, which
// contains committed changes only. On a fresh ticket branch the new work is
// entirely uncommitted, so the reviewer either rejects an empty diff or, if
// earlier commits exist, reviews a real diff that does not contain the
// implementation. A review of code that is not there is worse than no
// review: it produces a green tick.
//
// This script is the gate in front of that. It refuses to let a review start
// unless the work is committed and the worktree is clean, and it prints the
// base and head the review must be run against, so the review is bound to a
// revision rather than to a moment.
//
// Usage:
//   node scripts/review-preflight.mjs [base]
//
// `base` defaults to main. It prints a block to paste into the pull request.

import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'main';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const problems = [];

let head = '';
let branch = '';
try {
  head = git(['rev-parse', 'HEAD']);
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
} catch {
  console.error('review-preflight: this is not a git repository, or it has no commits.');
  process.exit(2);
}

// 1. A clean worktree. Anything uncommitted is invisible to the review.
const status = git(['status', '--porcelain']);
if (status !== '') {
  problems.push(
    'the worktree is not clean. Everything below is invisible to a review that\n' +
      '    diffs commits, which is every review this repository runs:\n\n' +
      status
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n') +
      '\n\n    Commit the complete ticket, or stash what does not belong to it.',
  );
}

// 2. The branch is not the base. A ticket has its own branch.
if (branch === base) {
  problems.push(
    `you are on ${base}. A ticket runs on its own branch in its own worktree;\n` +
      '    that is one of the three rules in AGENTS.md.',
  );
}

// 3. There is something to review.
let commits = [];
let mergeBase = '';
try {
  mergeBase = git(['merge-base', base, 'HEAD']);
  commits = git(['log', '--format=%h %s', `${mergeBase}..HEAD`])
    .split('\n')
    .filter(Boolean);
} catch {
  problems.push(`${base} does not resolve, so there is nothing to compare against.`);
}

if (mergeBase !== '' && commits.length === 0) {
  problems.push(
    `there are no commits on this branch beyond ${base}. There is nothing to\n` +
      '    review. If you have done the work, it is uncommitted.',
  );
}

// An empty final diff. The branch has commits, but nothing survives against
// the base: a change and its revert, or work already merged. The review skill
// rejects an empty diff, so announcing "ready" here sends the next step
// straight into a refusal. Round four found the pass two rehearsal doing
// exactly that: two commits, zero changed files, "ready".
const changedFiles =
  mergeBase === ''
    ? []
    : git(['diff', '--name-only', `${mergeBase}...HEAD`])
        .split('\n')
        .filter(Boolean);

if (mergeBase !== '' && commits.length > 0 && changedFiles.length === 0) {
  problems.push(
    `there are ${commits.length} commit(s) on this branch but nothing differs from\n` +
      `    ${base}. A review of an empty diff reviews nothing, and the review skill\n` +
      '    refuses one. If the work was reverted, say so and close the branch; if it\n' +
      '    landed another way, the ticket is done.',
  );
}

if (problems.length > 0) {
  console.error('review-preflight: not ready for review.\n');
  for (const p of problems) console.error(`  - ${p}\n`);
  console.error(
    'review-preflight: a review is bound to a revision, not to a moment. Fix the\n' +
      'review-preflight: above, then run this again and paste its block into the\n' +
      'review-preflight: pull request. See docs/agents/review-checkpoint.md.',
  );
  process.exit(1);
}

const files = changedFiles;

console.log('review-preflight: ready.\n');
console.log('Review checkpoint');
console.log(`  branch:      ${branch}`);
console.log(`  base:        ${base}`);
console.log(`  merge base:  ${mergeBase}`);
console.log(`  head:        ${head}`);
console.log(`  commits:     ${commits.length}`);
for (const c of commits) console.log(`    ${c}`);
console.log(`  files:       ${files.length}`);
for (const f of files) console.log(`    ${f}`);
console.log(`\n  review command: git diff ${mergeBase}...${head}`);
console.log(
  '\n  This head is what the review covers. Any commit after it invalidates\n' +
    '  the review and the checks: run both again and record the new head.',
);
