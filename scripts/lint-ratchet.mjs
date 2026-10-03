// SPDX-License-Identifier: AGPL-3.0-only
// The lint ratchet: lint stays green while pedantic warnings pile up unseen,
// so this counts them per rule and fails when any count rises.
//
// It fails on four things:
//
//   1. a rule has more warnings than lint-baseline.json records (a rule the
//      baseline does not name counts as 0);
//   2. lint-baseline.json holds more for any rule than the base branch's copy,
//      because the baseline can only be lowered;
//   3. a product source file (scripts, styles and pages under apps/ and
//      packages/, tests excluded) is over 1,000 physical lines;
//   4. oxlint linted no file, or the base branch cannot be read. Either would
//      otherwise pass having compared nothing.
//
// Fewer warnings than the baseline pass, and the run says so. Lower the
// baseline in the same change with `pnpm lint:baseline`, which writes the
// current counts and refuses when any of them is above the base branch's.
//
// When lint-baseline/ exists it is the baseline, one file per area
// (scripts/lint-baseline-areas.ts), and each area is held on its own: its
// warnings against its file, its file against the base's copy. A base that
// still has the single file (the cut) holds the joined totals instead.
// `--split` writes the folder from the current counts, once, and proves its
// join equals lint-baseline.json. Without the folder nothing changes.
//
// The base branch is BASE_SHA when set, else origin/$GITHUB_BASE_REF (the pull
// request's base in Actions), else origin/main. Actions checks out one commit,
// so when that ref is absent it is fetched at depth 1. A base with no baseline
// file (the change that adds the ratchet) has nothing to compare against.
//
// Usage: node scripts/lint-ratchet.mjs [--write | --split]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASELINE,
  BASELINE_DIR,
  areaRises,
  countByArea,
  countRules,
  formatRules,
  joinAreas,
  parseAreaFiles,
  parseRules as parse,
  readBaseline,
  rises,
  sameRules,
  splitBaseline,
} from './lint-baseline-areas.ts';

const MAX_LINES = 1000;
const OXLINT = join(import.meta.dirname, '../node_modules/.bin/oxlint');
const write = process.argv.includes('--write');
const split = process.argv.includes('--split');

function fail(message) {
  console.error(`lint ratchet: ${message}`);
  process.exit(1);
}

function git(...args) {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  return run.status === 0 ? run.stdout : undefined;
}

/** `run()`, or the run ends with the message it threw. */
function attempt(run) {
  try {
    return run();
  } catch (error) {
    return fail(error.message);
  }
}

function lintReport() {
  const run = spawnSync(OXLINT, ['--format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  let report;
  try {
    // An empty run prints a sentence before the JSON.
    report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
  } catch {
    fail(`oxlint gave no readable report (exit ${run.status}).\n${run.stderr}`);
  }
  if (!(report.number_of_files > 0)) fail('oxlint linted no file, so there is nothing to compare.');
  return report.diagnostics;
}

/** The base branch's baseline: its folder when it has one, else its single file, else none. */
function baseBaseline() {
  const ref = process.env['BASE_SHA'] || `origin/${process.env['GITHUB_BASE_REF'] || 'main'}`;
  let commit = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)?.trim();
  if (!commit && process.env['GITHUB_ACTIONS'] === 'true' && ref.startsWith('origin/')) {
    git('fetch', '--no-tags', '--depth=1', 'origin', ref.slice('origin/'.length));
    commit = git('rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}')?.trim();
  }
  if (!commit) fail(`cannot read the base ${ref}; set BASE_SHA to the base branch's commit.`);
  const names = git('ls-tree', '-z', '--name-only', commit, `${BASELINE_DIR}/`) ?? '';
  const files = names
    .split('\0')
    .filter(Boolean)
    .map((path) => ({
      name: path.slice(BASELINE_DIR.length + 1),
      text: git('show', `${commit}:${path}`) ?? '',
    }));
  if (files.length > 0) {
    return {
      kind: 'areas',
      areas: attempt(() => parseAreaFiles(files, `${BASELINE_DIR} on the base`)),
    };
  }
  const text = git('show', `${commit}:${BASELINE}`);
  return text === undefined
    ? undefined
    : { kind: 'total', rules: parseRules(text, `${BASELINE} on the base`) };
}

const parseRules = (text, where) => attempt(() => parse(text, where));
/** A baseline's totals per rule, whichever shape it has. */
const totalOf = (baseline) =>
  baseline.kind === 'areas' ? joinAreas(baseline.areas) : baseline.rules;

/** Writes one file per area, removing the file of any area no longer counted. */
function writeAreas(areas) {
  mkdirSync(BASELINE_DIR, { recursive: true });
  for (const name of readdirSync(BASELINE_DIR)) {
    if (name.endsWith('.json') && !(name.slice(0, -5) in areas)) rmSync(join(BASELINE_DIR, name));
  }
  for (const [area, rules] of Object.entries(areas)) {
    writeFileSync(join(BASELINE_DIR, `${area}.json`), formatRules(rules));
  }
}

/**
 * Lines as an editor numbers them: every line ending (LF, CRLF or a bare CR) ends one, and text
 * after the last is one more.
 */
function physicalLines(text) {
  return text.split(/\r\n|\r|\n/u).length - (/[\r\n]$/u.test(text) ? 1 : 0);
}

function oversizeProductFiles() {
  // -z: without it git quotes a name holding a tab or a non-ASCII byte, and the quoted
  // name is not a path, so the file would be skipped.
  const listed =
    git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages') ??
    '';
  return listed
    .split('\0')
    .filter(
      (f) =>
        /\.(?:[cm]?[jt]sx?|css|html)$/iu.test(f) &&
        !/(?:^|\/)tests\/|\.(?:test|spec)\./u.test(f) &&
        existsSync(f),
    )
    .map((f) => ({ f, lines: physicalLines(readFileSync(f, 'utf8')) }))
    .filter(({ lines }) => lines > MAX_LINES);
}

const diagnostics = lintReport();
const counts = countRules(diagnostics);
const base = baseBaseline();
const problems = [];

for (const { f, lines } of oversizeProductFiles()) {
  problems.push(`${f}: ${lines} lines, over the ${MAX_LINES}-line limit for product source.`);
}

if (split) {
  if (existsSync(BASELINE_DIR)) fail(`${BASELINE_DIR}/ already exists; --split makes it once.`);
  if (!existsSync(BASELINE)) fail(`${BASELINE} is missing, so there is nothing to split.`);
  const single = parseRules(readFileSync(BASELINE, 'utf8'), BASELINE);
  writeAreas(attempt(() => splitBaseline(single, countByArea(diagnostics))));
  const back = attempt(() => readBaseline('.'));
  if (back?.kind !== 'areas' || !sameRules(joinAreas(back.areas), single)) {
    fail(`${BASELINE_DIR}/ does not join back to ${BASELINE}.`);
  }
  console.log(`lint ratchet: wrote ${BASELINE_DIR}/; joined, they equal ${BASELINE}.`);
}

const where = ({ area }) => (area ? `${area}: ` : '');
const byArea = existsSync(BASELINE_DIR);
const areaCounts = byArea ? attempt(() => countByArea(diagnostics)) : {};
const wrote = byArea ? BASELINE_DIR : BASELINE;

if (write) {
  let higher = [];
  if (byArea && base?.kind === 'areas') higher = areaRises(areaCounts, base.areas);
  else if (base) higher = rises(counts, totalOf(base));
  if (higher.length > 0) {
    fail(
      `the baseline can only be lowered. Remove the new warnings instead:\n${higher
        .map((r) => `  ${where(r)}${r.rule}: ${r.n} here, ${r.was} on the base`)
        .join('\n')}`,
    );
  }
  if (byArea) writeAreas(areaCounts);
  else writeFileSync(BASELINE, formatRules(counts));
  console.log(`lint ratchet: wrote ${wrote}.`);
}

const head = attempt(() => readBaseline('.'));
if (!head) fail(`${BASELINE} is missing. Write it with \`pnpm lint:baseline\`.`);
const recorded = totalOf(head);

const lowered = (r) => `${r.rule}: ${r.n} here, ${r.was} on the base.`;
if (head.kind === 'areas' && base?.kind === 'areas') {
  for (const r of areaRises(head.areas, base.areas)) {
    problems.push(`the baseline can only be lowered in ${r.area}: ${lowered(r)}`);
  }
} else if (base) {
  for (const r of rises(recorded, totalOf(base))) {
    problems.push(`the baseline can only be lowered: ${lowered(r)}`);
  }
}
const risen = head.kind === 'areas' ? areaRises(areaCounts, head.areas) : rises(counts, recorded);
for (const { area, rule, n, was } of risen) {
  problems.push(`new warnings${area ? ` in ${area}` : ''}: ${rule}: ${n}, baseline ${was}.`);
}

const rules = [...new Set([...Object.keys(counts), ...Object.keys(recorded)])].toSorted();
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
console.log('   now  baseline  rule');
for (const rule of rules) {
  console.log(
    `${String(counts[rule] ?? 0).padStart(6)}  ${String(recorded[rule] ?? 0).padStart(8)}  ${rule}`,
  );
}
console.log(`total: ${sum(counts)} warnings, baseline ${sum(recorded)}.`);

if (problems.length > 0) fail(`\n${problems.map((p) => `  ${p}`).join('\n')}`);
const slack =
  head.kind === 'areas'
    ? areaRises(head.areas, areaCounts).length > 0
    : rules.some((rule) => (counts[rule] ?? 0) < (recorded[rule] ?? 0));
if (slack) {
  console.log(
    'Fewer warnings than the baseline: lower it in this change with `pnpm lint:baseline`.',
  );
}
console.log('lint ratchet: green.');
