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
// The base branch is BASE_SHA when set, else origin/$GITHUB_BASE_REF (the pull
// request's base in Actions), else origin/main. Actions checks out one commit,
// so when that ref is absent it is fetched at depth 1. A base with no baseline
// file (the change that adds the ratchet) has nothing to compare against.
//
// Usage: node scripts/lint-ratchet.mjs [--write]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE = 'lint-baseline.json';
const MAX_LINES = 1000;
const OXLINT = join(import.meta.dirname, '../node_modules/.bin/oxlint');
const write = process.argv.includes('--write');

function fail(message) {
  console.error(`lint ratchet: ${message}`);
  process.exit(1);
}

function git(...args) {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  return run.status === 0 ? run.stdout : undefined;
}

function countWarnings() {
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
  const counts = {};
  for (const { code, severity } of report.diagnostics) {
    if (severity === 'warning') counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function baseRules() {
  const ref = process.env['BASE_SHA'] || `origin/${process.env['GITHUB_BASE_REF'] || 'main'}`;
  let commit = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)?.trim();
  if (!commit && process.env['GITHUB_ACTIONS'] === 'true' && ref.startsWith('origin/')) {
    git('fetch', '--no-tags', '--depth=1', 'origin', ref.slice('origin/'.length));
    commit = git('rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}')?.trim();
  }
  if (!commit) fail(`cannot read the base ${ref}; set BASE_SHA to the base branch's commit.`);
  const text = git('show', `${commit}:${BASELINE}`);
  return text === undefined ? undefined : parseRules(text, `${BASELINE} on the base`);
}

/**
 * A baseline's counts, each a whole number of at least 0. Anything else fails, because a
 * count that is not a number compares false against every warning and so would hide them.
 */
function parseRules(text, where) {
  let rules;
  try {
    ({ rules } = JSON.parse(text));
  } catch {
    fail(`${where} is not JSON.`);
  }
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
    fail(`${where} has no \`rules\` object.`);
  }
  for (const [rule, n] of Object.entries(rules)) {
    if (!Number.isInteger(n) || n < 0)
      fail(`${where}: ${rule} is ${JSON.stringify(n)}, not a count.`);
  }
  return rules;
}

/** Each rule whose count in `next` is above its count in `base`. */
function rises(next, base) {
  return Object.entries(next)
    .filter(([rule, n]) => n > (base[rule] ?? 0))
    .map(([rule, n]) => ({ rule, n, was: base[rule] ?? 0 }));
}

/** Lines as an editor numbers them: every newline ends one, and text after the last is one more. */
function physicalLines(text) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function oversizeProductFiles() {
  const listed =
    git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages') ?? '';
  return listed
    .split('\n')
    .filter(
      (f) =>
        /\.(?:[cm]?[jt]sx?|css|html)$/u.test(f) &&
        !/(?:^|\/)tests\/|\.(?:test|spec)\./u.test(f) &&
        existsSync(f),
    )
    .map((f) => ({ f, lines: physicalLines(readFileSync(f, 'utf8')) }))
    .filter(({ lines }) => lines > MAX_LINES);
}

const counts = countWarnings();
const base = baseRules();
const problems = [];

for (const { f, lines } of oversizeProductFiles()) {
  problems.push(`${f}: ${lines} lines, over the ${MAX_LINES}-line limit for product source.`);
}

if (write) {
  const higher = base ? rises(counts, base) : [];
  if (higher.length > 0) {
    fail(
      `the baseline can only be lowered. Remove the new warnings instead:\n${higher
        .map(({ rule, n, was }) => `  ${rule}: ${n} here, ${was} on the base`)
        .join('\n')}`,
    );
  }
  const rules = Object.fromEntries(
    Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(BASELINE, `${JSON.stringify({ rules }, null, 2)}\n`);
  console.log(`lint ratchet: wrote ${BASELINE}.`);
}

if (!existsSync(BASELINE)) fail(`${BASELINE} is missing. Write it with \`pnpm lint:baseline\`.`);
const recorded = parseRules(readFileSync(BASELINE, 'utf8'), BASELINE);

for (const { rule, n, was } of base ? rises(recorded, base) : []) {
  problems.push(`the baseline can only be lowered: ${rule}: ${n} here, ${was} on the base.`);
}
for (const { rule, n, was } of rises(counts, recorded)) {
  problems.push(`new warnings: ${rule}: ${n}, baseline ${was}.`);
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
if (rules.some((rule) => (counts[rule] ?? 0) < (recorded[rule] ?? 0))) {
  console.log(
    'Fewer warnings than the baseline: lower it in this change with `pnpm lint:baseline`.',
  );
}
console.log('lint ratchet: green.');
