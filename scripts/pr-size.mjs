// SPDX-License-Identifier: AGPL-3.0-only
// The pull request size gate.
//
// Warn at 300 changed lines of non-test code, block at 400. The ceiling is
// not arbitrary: past about that size, review stops finding defects, and a
// reviewer who cannot really review is worse than no reviewer at all.
//
// Test files are listed but never counted, towards the total or the per-file
// cap (CQ-16, the owner's process fix of 29 September 2026): the reviewer's
// proof tests were pushing reviewed pull requests over the cap. A test file
// is a path under `tests/` or a file named `*.test.*` or `*.spec.*`; that
// takes in `tests/db/named-suites.json`, the manifest the suites read.
// Anything else counts, fixtures and scripts outside `tests/` included, and
// a file moved between code and tests counts unless both of its paths are
// tests.
//
// Moved lines are not counted either, towards the total or the per-file cap
// (issue 110): a reviewer reads a block cut from one place and pasted into
// another, or re-indented when it is wrapped into a named step, as moved,
// not as new. A line is moved when git's own move detection says so
// (`--color-moved=plain --color-moved-ws=allow-indentation-change`). A moved
// line that is then edited is new text and counts. Moves are only looked for
// between non-test files, so code cannot enter a test file uncounted and then
// be moved out of it uncounted as well.
//
// Two waivers, each a label, each needing a reason written on the pull
// request. Two anti-gaming rules come with them: a per-file cap, and the
// requirement that a split names the invariant test that only passes once
// every part has landed. The second one is a human check at merge; this
// script does the first.
//
// The rule is written for people in CONTRIBUTING.md. This file must agree
// with it.

import { execFileSync } from 'node:child_process';

const WARN_AT = 300;
const BLOCK_AT = 400;
const PER_FILE_CAP = 400;

const MECHANICAL_LABEL = 'size-waiver-mechanical';
const COHERENCE_LABEL = 'size-waiver-coherence';

// Files a human did not hand-write. They still count towards the total,
// because a reviewer still has to look at the pull request, but they do not
// trip the per-file cap.
const GENERATED = [
  /(^|\/)pnpm-lock\.yaml$/u,
  /(^|\/)package-lock\.json$/u,
  /(^|\/)yarn\.lock$/u,
  /(^|\/)LICENSE$/u,
  /\.snap$/u,
  /(^|\/)dist\//u,
  /\.generated\.[a-z]+$/u,
];

const TEST = [/^tests\//u, /(^|\/)[^/]+\.(test|spec)\.[^/]+$/u];
const isTest = (path) => TEST.some((r) => r.test(path));

const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
const labels = (process.env.PR_LABELS ?? '')
  .split(',')
  .map((l) => l.trim())
  .filter(Boolean);

if (!base || !head) {
  console.error('pr-size: BASE_SHA and HEAD_SHA must both be set.');
  process.exit(2);
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 ** 3 });

// The merge base, not the base branch tip, or every commit that landed on
// main since the branch started would be counted against the author.
const mergeBase = git(['merge-base', base, head]).trim();

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
    records.push({ paths, path: paths.join(' => '), changed: added + deleted });
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
  if (!agree) {
    console.error(
      'pr-size: the coloured patch and the numstat disagree; cannot count moved lines.',
    );
    process.exit(2);
  }
  return new Map(
    records.map((record, i) => [record.path, { ...record, moved: sections[i].moved }]),
  );
};

const moved = movedLines();
const files = [];
const tests = [];
let total = 0;
let movedTotal = 0;
let testTotal = 0;

for (const { paths, path, changed } of diffRecords([mergeBase, head])) {
  if (paths.every(isTest)) {
    testTotal += changed;
    tests.push({ path, changed });
    continue;
  }
  // A file the non-test diff pairs differently, such as one renamed from a
  // test file, finds no matching entry here, and every one of its lines counts.
  const entry = moved.get(path);
  const movedHere = entry?.changed === changed ? entry.moved : 0;
  const counted = changed - movedHere;
  total += counted;
  movedTotal += movedHere;
  files.push({
    path,
    changed,
    moved: movedHere,
    counted,
    generated: GENERATED.some((r) => r.test(paths.at(-1))),
  });
}

const hasMechanical = labels.includes(MECHANICAL_LABEL);
const hasCoherence = labels.includes(COHERENCE_LABEL);
const waived = hasMechanical || hasCoherence;

const annotate = (level, message) => console.log(`::${level}::${message}`);

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
console.log(`pr-size: warn at ${WARN_AT}, block at ${BLOCK_AT}, per-file cap ${PER_FILE_CAP}.`);
if (labels.length > 0) console.log(`pr-size: labels: ${labels.join(', ')}`);

const failures = [];

if (total > BLOCK_AT) {
  if (waived) {
    const which = hasMechanical ? MECHANICAL_LABEL : COHERENCE_LABEL;
    annotate(
      'warning',
      `This pull request is ${total} changed lines of non-test code, over the ${BLOCK_AT} line ceiling, ` +
        `and is allowed through by ${which}. The reason must be written on the pull request.`,
    );
  } else {
    failures.push(
      `${total} changed lines of non-test code is over the ${BLOCK_AT} line ceiling. Split it, or apply ` +
        `${MECHANICAL_LABEL} or ${COHERENCE_LABEL} with a reason. If you split it, name the ` +
        `invariant test that only passes once every part has landed. See CONTRIBUTING.md.`,
    );
  }
} else if (total >= WARN_AT) {
  annotate(
    'warning',
    `This pull request is ${total} changed lines of non-test code. The ceiling is ${BLOCK_AT}. Consider splitting it.`,
  );
}

// The per-file cap. **No label lifts it.**
//
// Round four found the mechanical waiver lifting this as well as the total,
// so one label let a single unreadable file through. The two limits exist for
// different reasons: the total is about how much a reviewer can hold in one
// sitting, and the per-file cap is about a file nobody can read at all. A
// genuinely generated file is caught by its pattern below without anyone
// applying a label, which is the honest route. If a file is generated and its
// pattern is missing, add the pattern.
for (const file of files) {
  if (file.counted <= PER_FILE_CAP) continue;
  if (file.generated) {
    annotate(
      'warning',
      `${file.path} changes ${file.counted} lines, over the per-file cap of ${PER_FILE_CAP}, ` +
        'allowed because it matches a generated-file pattern.',
    );
    continue;
  }
  failures.push(
    `${file.path} changes ${file.counted} hand-written lines, not counting moved ones, over the per-file cap of ` +
      `${PER_FILE_CAP}. Splitting the pull request without splitting this file does not help ` +
      'a reviewer, and no label lifts this cap. If the file is generated, add its pattern ' +
      'to GENERATED in this script rather than labelling around it.',
  );
}

if (failures.length > 0) {
  for (const failure of failures) annotate('error', failure);
  process.exit(1);
}

console.log('pr-size: within the rule.');
