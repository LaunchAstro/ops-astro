// SPDX-License-Identifier: AGPL-3.0-only
// The pre-ready gate: what a lane runs before every push that will go to
// review, so a red that CI would find costs one local minute instead of a new
// head, a new security read and a new review.
//
// It calls the repository's own checkers and tests; it edits none of them and
// re-implements none of their rules. In order, stopping at the first red:
//
//   preflight  scripts/review-preflight.mjs: committed, clean, on a branch.
//   (a)  the whole `pnpm check`. It is heavy: run it on the M5 and pass
//        --skip-check here, and the gate says it did not run it.
//   (b)  changed-file lint: oxlint and prettier on the changed files, then
//        scripts/lint-ratchet.mjs.
//   (c)  named-suite registration: tests/db/named-suite-manifest.test.ts,
//        whatever layout the manifest has at the time.
//   (d)  commit trailers on every commit in the range, merge commits
//        included: scripts/commit-range-check.mjs.
//   (e)  review evidence on the pull request body: scripts/review-evidence-
//        check.mjs as origin/main has it at run time, copied fresh, never a
//        local copy that may be stale.
//   (f)  behaviour test names: tests/docs/test-files-by-behaviour.test.ts.
//   (g)  `git merge-tree` against origin/main, naming any conflicted file.
//
// The pull request body, labels and commit messages are untrusted text. This
// script parses none of them: the body goes to the evidence checker as it is,
// the messages to git's own trailer parser, and GitHub's answer through
// JSON.parse. File names and merge-tree output are read NUL-separated.
//
// Only (e) takes its checker from origin/main. The others run as the branch
// has them; when the branch is behind main the gate says so, because CI's
// queue runs main's newer rules on the merged head.
//
// Usage:
//   node scripts/pre-ready.mjs --pr <number> [--skip-check]
//   node scripts/pre-ready.mjs --body-file <path> [--labels <a,b>] [--skip-check]
//
//   --pr          read the body and labels of that pull request from GitHub.
//   --body-file   the body you are about to post, before the pull request
//                 exists or before you edit it.
//   --skip-check  pnpm check already ran on this head elsewhere (the M5).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  behaviourNames,
  changedLint,
  commitTrailers,
  git,
  mergeTree,
  preflight,
  reviewEvidence,
  run,
  runGate,
  short,
  suiteRegistration,
  wholeCheck,
} from './pre-ready-steps.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

const USAGE =
  'usage: node scripts/pre-ready.mjs (--pr <number> | --body-file <path> [--labels <a,b>]) [--skip-check]';

/** The command line, read as a closed set of flags. */
function readArgs(argv) {
  const args = { skip: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === '--skip-check') args.skip = true;
    else if (flag === '--pr') args.pr = value();
    else if (flag === '--body-file') args.bodyFile = value();
    else if (flag === '--labels') args.labels = value();
    else throw new Error(`unknown argument ${JSON.stringify(flag)}`);
  }
  if ((args.pr === undefined) === (args.bodyFile === undefined)) {
    throw new Error('give exactly one of --pr and --body-file');
  }
  if (args.pr !== undefined && !/^[1-9][0-9]{0,6}$/u.test(args.pr)) {
    throw new Error('--pr takes a pull request number');
  }
  if (args.pr !== undefined && args.labels !== undefined) {
    throw new Error('--labels goes with --body-file; --pr reads the labels from GitHub');
  }
  return args;
}

/** The body and labels: from GitHub's REST answer, or from the caller. */
function readBody(args, head) {
  if (args.bodyFile !== undefined) {
    const labels = (args.labels ?? '').split(',').map((label) => label.trim());
    return { body: readFileSync(args.bodyFile, 'utf8'), labels: labels.join('\n') };
  }
  const answer = run('gh', ['api', `repos/{owner}/{repo}/pulls/${args.pr}`], { cwd: repoRoot });
  if (answer.status !== 0) throw new Error(`gh api could not read pull request ${args.pr}`);
  const pull = JSON.parse(answer.stdout);
  if (pull.head?.sha !== head) {
    console.log(
      `pre-ready: GitHub's head for #${args.pr} is ${short(String(pull.head?.sha))}; this gate checks the local head ${short(head)}, and the body must name it.`,
    );
  }
  const labels = Array.isArray(pull.labels) ? pull.labels.map((label) => String(label.name)) : [];
  return { body: typeof pull.body === 'string' ? pull.body : '', labels: labels.join('\n') };
}

/** Open issue numbers, one per line, read as review-evidence.yml reads them. */
function readOpenIssues() {
  const answer = run(
    'gh',
    [
      'api',
      '--paginate',
      'repos/{owner}/{repo}/issues?state=open&per_page=100',
      '--jq',
      '.[] | select(.pull_request == null) | .number',
    ],
    { cwd: repoRoot },
  );
  if (answer.status !== 0) throw new Error('gh api could not list the open issues');
  return answer.stdout;
}

/**
 * The whole gate, in order: admission, then (a) to (g). `pr` is the body,
 * labels and open issues; `log` takes each step's line.
 */
export function gate({ cwd, base, head, skip, pr }, log) {
  const range = { cwd, tools: cwd, base, head };
  return runGate(
    [
      { id: 'preflight', name: 'review preflight', run: () => preflight(range) },
      { id: 'a', name: 'pnpm check', run: () => wholeCheck({ cwd, skip }) },
      { id: 'b', name: 'changed-file lint', run: () => changedLint(range) },
      { id: 'c', name: 'named-suite registration', run: () => suiteRegistration(range) },
      { id: 'd', name: 'commit trailers', run: () => commitTrailers(range) },
      {
        id: 'e',
        name: 'review evidence',
        run: () => reviewEvidence({ ...range, freshRef: 'origin/main', ...pr }),
      },
      { id: 'f', name: 'behaviour test names', run: () => behaviourNames(range) },
      { id: 'g', name: 'merge-tree against origin/main', run: () => mergeTree(range) },
    ],
    log,
  );
}

function main() {
  let args;
  try {
    args = readArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`pre-ready: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const cwd = repoRoot;
  try {
    git(cwd, 'fetch', '-q', 'origin', 'main');
  } catch {
    console.error('pre-ready: could not fetch origin main; nothing checked.');
    process.exit(1);
  }
  const base = git(cwd, 'rev-parse', 'origin/main').trim();
  const head = git(cwd, 'rev-parse', 'HEAD').trim();
  let pr;
  try {
    pr = { ...readBody(args, head), openIssues: readOpenIssues() };
  } catch (error) {
    console.error(`pre-ready: ${error.message}; nothing checked.`);
    process.exit(1);
  }
  const behind = git(cwd, 'rev-list', '--count', `${head}..${base}`).trim();
  if (behind !== '0') {
    console.log(
      `pre-ready: this branch is ${behind} commit(s) behind origin/main. Steps (b) to (d) and (f) run the branch's own checkers; CI's queue runs main's.`,
    );
  }
  const result = gate({ cwd, base, head, skip: args.skip, pr }, (line) => console.log(line));
  if (!result.ok) {
    console.log(`pre-ready: red at (${result.failed}); fix it and run again before pushing.`);
    process.exit(1);
  }
  const skipped = args.skip ? ' (a) was skipped: pnpm check ran elsewhere, not here.' : '';
  console.log(`pre-ready: green for ${short(head)} against origin/main ${short(base)}.${skipped}`);
}

if (process.argv[1] === import.meta.filename) main();
