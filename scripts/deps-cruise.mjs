// SPDX-License-Identifier: AGPL-3.0-only
// Structural dependency rules, and proof that they were read.
//
// Item 9 of the PG0 product ticket asks for dependency-cruiser as a check.
// Running `depcruise` directly is not that check, for a reason this tree
// demonstrates rather than predicts.
//
// dependency-cruiser 18.4.0's default TypeScript path supports
// `typescript: >=2.0.0 <7.0.0`, and says so: "Support for typescript@>=7 will
// follow when its API is published and stable." This repository pins
// typescript 7.0.2. On that path, 18.4.0 points at a TypeScript tree and
// prints `no dependency violations found (0 modules, 0 dependencies cruised)`
// and exits 0. Measured on 18.4.0 on 23 September, not assumed fixed from
// 18.3.0: three TypeScript modules cruised as zero modules, zero errors,
// exit 0. Over a mixed tree it cruises the JavaScript, skips the TypeScript,
// prints nothing at all on stderr and exits 0.
//
// So .dependency-cruiser.cjs sets `parser: 'swc'`. @swc/core parses
// TypeScript without the TypeScript compiler, the whole configured tree is
// read, and a file swc cannot parse stops the cruise: depcruise exits 1 and
// writes no report at all.
//
// An earlier revision of this file instead carried a list of paths declared
// unreadable and skipped. That was a hole, and the coordinator's probe walked
// through it: a syntactically invalid file at a listed path was skipped, and
// the runner printed that the tree was read. Any code placed at that filename
// escaped the gate. There is no exemption list now, and there must not be
// one: a path that cannot be read is a failure, not an entry.
//
// This runner reads the JSON report and fails on four things:
//
//   1. dependency-cruiser returned no readable report, which is what a parse
//      error looks like from here;
//   2. it cruised zero modules, whatever it says about violations;
//   3. a source file in scope was not cruised at all;
//   4. any rule at severity `error` was violated.
//
// Usage: node scripts/deps-cruise.mjs [targets...]
//   DEPS_CRUISE_ROOT    the tree to cruise (default: this repository)
//   DEPS_CRUISE_CONFIG  the configuration (default: <root>/.dependency-cruiser.cjs)

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const root = resolve(process.env['DEPS_CRUISE_ROOT'] ?? repoRoot);
const config = resolve(process.env['DEPS_CRUISE_CONFIG'] ?? join(root, '.dependency-cruiser.cjs'));

// The tree this repository has. `scripts/` and `tests/` hold the modules that
// import each other; `apps/` and `packages/` are the seven .gitkeep files
// product code will arrive in, and they are named here so the cruise widens
// on its own the day it does.
const DEFAULT_TARGETS = ['scripts', 'tests', 'apps', 'packages'];

const args = process.argv.slice(2);
const targets = (args.length > 0 ? args : DEFAULT_TARGETS).filter((t) => existsSync(join(root, t)));

if (targets.length === 0) {
  console.error(`deps-cruise: none of the configured targets exist under ${root}.`);
  process.exit(2);
}

const binary = join(repoRoot, 'node_modules/.bin/depcruise');
if (!existsSync(binary)) {
  console.error(`deps-cruise: no dependency-cruiser at ${binary}.`);
  console.error('deps-cruise: run `pnpm install --frozen-lockfile` first.');
  process.exit(2);
}

/** Every source file under a target that the cruise is expected to read. */
const CRUISABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const sourcesUnder = (dir, found = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(full, found);
    else if (CRUISABLE.test(entry.name)) found.push(relative(root, full));
  }
  return found;
};

const run = spawnSync(binary, ['--config', config, '--output-type', 'json', ...targets], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (run.error !== undefined && run.error !== null) {
  console.error(`deps-cruise: could not run dependency-cruiser: ${String(run.error)}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(run.stdout ?? '');
} catch {
  // This is what a parse error looks like from here: swc stops the extraction
  // and depcruise writes no report. It is a gate failure, not a tool problem,
  // so it exits 1 and says nothing about the tree having been read.
  console.error('deps-cruise: dependency-cruiser read no report, so the cruise did not finish.');
  console.error(
    `deps-cruise: a source in ${targets.join(', ')} could not be parsed. Its own\n` +
      `deps-cruise: error follows. depcruise exited ${String(run.status)}.\n`,
  );
  console.error(run.stderr ?? '');
  process.exit(1);
}

const summary = report.summary ?? {};
const cruised = Number(summary.totalCruised ?? 0);
const violations = Array.isArray(summary.violations) ? summary.violations : [];
const modules = Array.isArray(report.modules) ? report.modules : [];
const read = new Set(modules.map((m) => String(m.source ?? '')));

const failures = [];

// 2. Silence is failure.
if (cruised === 0) {
  failures.push(
    'the cruise read zero modules and still reported no violations.\n' +
      `        Targets: ${targets.join(', ')}\n` +
      '        A tree that cruises nothing is not a clean tree. It is a tree\n' +
      '        that was not read, and dependency-cruiser exits 0 either way.',
  );
}

// 3. A source in scope that was not read. There is no exemption list, by
// design: the hole this closes was exactly such a list.
const skipped = targets.flatMap((t) => sourcesUnder(join(root, t))).filter((f) => !read.has(f));

if (skipped.length > 0) {
  failures.push(
    'sources are in scope and were not cruised:\n' +
      skipped.map((f) => `          ${f}`).join('\n') +
      '\n        A file the cruise did not read is a file the rules did not\n' +
      '        apply to. Make it readable, or take it out of the configured\n' +
      '        targets deliberately. Do not add it to an exemption list.',
  );
}

// 4. The rules themselves. The severity sits on the rule the violation cites,
// not on the violation, and reading the wrong one silently drops every
// finding. It did, until the cycle fixture in tests/ci/deps-cruise-cases.mjs
// caught it.
for (const v of violations) {
  const severity = String(v.rule?.severity ?? v.severity ?? '');
  if (severity !== 'error') continue;
  const to = String(v.to ?? '') === String(v.from ?? '') ? '' : ` → ${String(v.to)}`;
  failures.push(`${String(v.rule?.name ?? 'rule')}: ${String(v.from)}${to}`);
}

console.log(
  `deps-cruise: ${String(cruised)} module(s) cruised across ${String(targets.length)} target(s): ${targets.join(', ')}`,
);

if (failures.length > 0) {
  console.error(`\ndeps-cruise: ${String(failures.length)} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log('deps-cruise: the structural rules hold, and the tree was actually read.');
