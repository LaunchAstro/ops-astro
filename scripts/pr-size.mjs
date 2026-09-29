// SPDX-License-Identifier: AGPL-3.0-only
// The pull request size report.
//
// It measures and prints; no size fails it. The owner dropped the 400-line
// limit on 29 September 2026 (FU-400): the size is reported, not limited.
// About 400 lines stays a guide for a readable chunk, never a gate, and
// nothing is split into separate sessions, lanes or review queues to meet
// it. The script exits 0 whatever the size, so the required check 'pull
// request size' keeps its name and no size fails a pull request. Waiver
// labels and the per-file cap are gone; the report stays, for the rate data
// a reviewer or a planner can use. A failure to measure is not a size, and
// still fails with exit 2 (Sol, review 1 on #143): a green check always
// carries a report.
//
// Test files are listed but never counted, in the total or per file (CQ-16,
// the owner's process fix of 29 September 2026). A test file is a path under
// `tests/` or a file named `*.test.*` or `*.spec.*`; that takes in
// `tests/db/named-suites.json`, the manifest the suites read. Anything else
// counts, fixtures and scripts outside `tests/` included, and a file moved
// between code and tests counts unless both of its paths are tests.
//
// Moved lines are not counted either, in the total or per file (issue 110):
// a reviewer reads a block cut from one place and pasted into another, or
// re-indented when it is wrapped into a named step, as moved, not as new. A
// line is moved when git's own move detection says so
// (`--color-moved=plain --color-moved-ws=allow-indentation-change`). A moved
// line that is then edited is new text and counts. Moves are only looked for
// between non-test files, so code cannot enter a test file uncounted and then
// be moved out of it uncounted as well.
//
// The rule is written for people in CONTRIBUTING.md. This file must agree
// with it.

import { execFileSync } from 'node:child_process';

const annotate = (level, message) => console.log(`::${level}::${message}`);

// Anything that stops the measuring, a missing revision, a git failure or a
// patch that disagrees with the numstat, is an error and exit 2, with no
// report. The message is put on one line so nothing in it can start a
// workflow command of its own.
process.on('uncaughtException', (error) => {
  const message = String(error?.message ?? error).replace(/\s+/gu, ' ');
  annotate('error', `pr-size could not measure this pull request: ${message}`);
  process.exit(2);
});

const TEST = [/^tests\//u, /(^|\/)[^/]+\.(test|spec)\.[^/]+$/u];
const isTest = (path) => TEST.some((r) => r.test(path));

const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
if (!base || !head) throw new Error('BASE_SHA and HEAD_SHA must both be set.');

// git's stderr is captured, not inherited: on a failure it reaches the log
// only inside the one-line warning above, so nothing git echoes back, such
// as a revision holding a line break, can start a workflow command.
const git = (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 ** 3,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// The merge base, not the base branch tip, or every commit that landed on
// main since the branch started would be counted against the author.
const mergeBase = git(['merge-base', base, head]).trim();

// A path is printed as written unless it could be misread: one holding the
// rename arrow, the `: ` before a count, a quote, a backslash or a control
// character is printed as a JSON string. So a file named "a => b" and a
// rename from a to b never share a name in the report.
const shown = (path) => {
  const quoted = JSON.stringify(path);
  // JSON escapes exactly the quote, the backslash and control characters.
  const plain = quoted === `"${path}"` && !path.includes(' => ') && !path.includes(': ');
  return plain ? path : quoted;
};

// One record per file, in git's order. -z keeps each path as written, and
// gives a rename both of its paths.
const diffRecords = (args) => {
  const numstat = git(['diff', '--numstat', '-z', ...args]).split('\0');
  const records = [];
  for (let i = 0; i < numstat.length; i += 1) {
    const record = numstat[i];
    if (!record) continue;
    // Only the first two tabs separate fields: a path may hold a tab of its own.
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    const addedRaw = record.slice(0, first);
    const deletedRaw = record.slice(first + 1, second);
    const only = record.slice(second + 1);
    // A rename's record ends in a tab, and its two paths follow.
    const paths = only ? [only] : [numstat[i + 1] ?? '', numstat[i + 2] ?? ''];
    if (!only) i += 2;
    // A binary file shows as "-\t-\t<path>".
    const added = addedRaw === '-' ? 0 : Number(addedRaw);
    const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw);
    // `path` is for the report; `key` is the real path pair, which a literal
    // filename such as "a => b" cannot share with a rename.
    records.push({
      paths,
      path: paths.map(shown).join(' => '),
      key: JSON.stringify(paths),
      changed: added + deleted,
    });
  }
  return records;
};

// How many lines of each non-test file git marks as moved, by path. The
// patch is read in colour because that is the only form git reports moves
// in; every colour is set here, so no local setting can change the reading.
// Its file sections come in the same order as the numstat records of the
// same diff, and each section's line count must equal its record's, or the
// script stops rather than guess.
const MOVE_COLOURS = { old: 31, new: 32, oldMoved: 35, newMoved: 36, meta: 1 };
const COLOUR_NAMES = { 31: 'red', 32: 'green', 35: 'magenta', 36: 'cyan', 1: 'bold' };
const NON_TEST = [
  ':(top)',
  ':(top,exclude,glob)tests/**',
  ':(top,exclude,glob)**/*.test.*',
  ':(top,exclude,glob)**/*.spec.*',
];

const movedLines = () => {
  const args = ['--no-ext-diff', '--no-textconv', mergeBase, head, '--', ...NON_TEST];
  const colours = Object.entries(MOVE_COLOURS).flatMap(([slot, code]) => [
    '-c',
    `color.diff.${slot}=${COLOUR_NAMES[code]}`,
  ]);
  const patch = git([
    ...colours,
    'diff',
    '--color=always',
    '--color-moved=plain',
    '--color-moved-ws=allow-indentation-change',
    '--ws-error-highlight=none',
    ...args,
  ]);
  const sgr = '\u001B[';
  const sections = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith(`${sgr}${MOVE_COLOURS.meta}mdiff --git `)) {
      sections.push({ changed: 0, moved: 0 });
      continue;
    }
    // A changed line opens with its colour, then its sign.
    if (!line.startsWith(sgr) || sections.length === 0) continue;
    const end = line.indexOf('m', sgr.length);
    if (end === -1 || (line[end + 1] !== '+' && line[end + 1] !== '-')) continue;
    const code = Number(line.slice(sgr.length, end));
    const section = sections.at(-1);
    if (code === MOVE_COLOURS.old || code === MOVE_COLOURS.new) section.changed += 1;
    if (code === MOVE_COLOURS.oldMoved || code === MOVE_COLOURS.newMoved) {
      section.changed += 1;
      section.moved += 1;
    }
  }
  const records = diffRecords(args);
  const agree =
    records.length === sections.length &&
    records.every((record, i) => record.changed === sections[i].changed);
  if (!agree)
    throw new Error('the coloured patch and the numstat disagree; cannot count moved lines.');
  return new Map(records.map((record, i) => [record.key, { ...record, moved: sections[i].moved }]));
};

const moved = movedLines();
const files = [];
const tests = [];
let total = 0;
let movedTotal = 0;
let testTotal = 0;

for (const { paths, path, key, changed } of diffRecords([mergeBase, head])) {
  if (paths.every(isTest)) {
    testTotal += changed;
    tests.push({ path, changed });
    continue;
  }
  // A file the non-test diff pairs differently, such as one renamed from a
  // test file, finds no matching entry here, and every one of its lines counts.
  const entry = moved.get(key);
  const movedHere = entry?.changed === changed ? entry.moved : 0;
  const counted = changed - movedHere;
  total += counted;
  movedTotal += movedHere;
  files.push({ path, changed, moved: movedHere, counted });
}

console.log(`pr-size: ${total} changed lines of non-test code across ${files.length} file(s).`);
console.log(`pr-size: ${movedTotal} moved lines of non-test code, not counted.`);
console.log(
  `pr-size: ${testTotal} changed test lines across ${tests.length} file(s), not counted.`,
);
for (const file of files) {
  console.log(
    `pr-size:   ${file.path}: ${file.counted} counted, ${file.moved} treated as moved ` +
      `(${file.changed} changed)`,
  );
}
for (const test of tests) console.log(`pr-size:   ${test.path} (${test.changed}, test)`);
console.log('pr-size: the size is reported, not limited; no size fails this check.');
