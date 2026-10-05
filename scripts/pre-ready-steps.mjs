// SPDX-License-Identifier: AGPL-3.0-only
// The steps of the pre-ready gate (scripts/pre-ready.mjs), one function each.
// Each takes the tree to run in (`cwd`), where the checkers and binaries come
// from (`tools`, the same tree when a lane runs the gate) and the range, and
// returns { ok, message }. None edits or re-implements the checker it calls.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Extensions oxlint reads; prettier reads what it knows and ignores the rest. */
const LINTED = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx']);
const REGISTRATION = 'tests/db/named-suite-manifest.test.ts';
const NAMES = 'tests/docs/test-files-by-behaviour.test.ts';
/** The evidence checker and the one module it imports from this repository. */
const FRESH = ['review-evidence-check.mjs', 'review-evidence-read.mjs'];
/**
 * Variables the composed checkers read, cleared so the caller's shell cannot
 * change a verdict or hand a checker a token; the gate sets the ones it means.
 */
const CHECKER_ENV = [
  'PR_BODY',
  'PR_LABELS',
  'HEAD_SHA',
  'BASE_SHA',
  'CHANGED_FILES',
  'AGENT_MODELS',
  'OPEN_ISSUES',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'GITHUB_API_URL',
  'HUB_RANGE_INCLUDE_ROOT',
  'CI',
];

export const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
export const run = (command, args, options) =>
  spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
export const short = (sha) => sha.slice(0, 9);
const tail = (result, lines = 60) =>
  `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd().split('\n').slice(-lines).join('\n');
export const green = (message) => ({ ok: true, message });
export const red = (message, result) => ({
  ok: false,
  message: result === undefined ? message : `${message}\n${tail(result)}`,
});

/** An environment with none of the checkers' variables, then `set`. */
function checkerEnv(set) {
  const env = { ...process.env };
  for (const key of CHECKER_ENV) delete env[key];
  return { ...env, ...set };
}

/** Paths that differ between the merge base and head, by git's diff filter. */
function changedPaths(cwd, base, head, filter) {
  const mergeBase = git(cwd, 'merge-base', base, head).trim();
  return git(cwd, 'diff', '-z', '--name-only', `--diff-filter=${filter}`, mergeBase, head)
    .split('\0')
    .filter(Boolean);
}

/** Runs a test file of this tree with the tree's own vitest. */
function vitestFile(cwd, tools, file) {
  return run(join(tools, 'node_modules', '.bin', 'vitest'), ['run', file], { cwd });
}

/** Runs each step in order and stops at the first red. */
export function runGate(steps, log) {
  for (const step of steps) {
    const result = step.run();
    if (!result.ok) {
      log(`pre-ready: (${step.id}) ${step.name}: red.\n${result.message}`);
      return { ok: false, failed: step.id };
    }
    log(`pre-ready: (${step.id}) ${step.name}: green. ${result.message}`);
  }
  return { ok: true };
}

/** (a) The whole `pnpm check`, through the pnpm running this, as scripts/check.mjs finds it. */
export function wholeCheck({ cwd, skip }) {
  if (skip) {
    return green(
      'skipped: --skip-check says pnpm check ran on this head elsewhere (the M5); this gate did not run pnpm check.',
    );
  }
  const execPath = process.env['npm_execpath'];
  const isScript = execPath !== undefined && ['.js', '.cjs', '.mjs'].includes(extname(execPath));
  const command = execPath === undefined ? 'pnpm' : isScript ? process.execPath : execPath;
  const prefix = isScript ? [execPath] : [];
  const result = run(command, [...prefix, 'check'], { cwd, stdio: 'inherit' });
  if (result.error !== undefined) {
    return red(
      `could not start pnpm (${result.error.message}). Run pnpm check on the M5 and pass --skip-check.`,
    );
  }
  return result.status === 0
    ? green('pnpm check passed.')
    : red(`pnpm check failed (exit ${result.status}); its output is above.`);
}

/** (b) oxlint and prettier on the changed files, then the lint ratchet. */
export function changedLint({ cwd, tools, base, head }) {
  const files = changedPaths(cwd, base, head, 'd');
  const bin = (name) => join(tools, 'node_modules', '.bin', name);
  const linted = files.filter((file) => LINTED.has(extname(file)));
  if (linted.length > 0) {
    const lint = run(bin('oxlint'), ['--no-error-on-unmatched-pattern', '--', ...linted], {
      cwd,
    });
    if (lint.status !== 0) return red(`oxlint failed on the changed files:`, lint);
  }
  if (files.length > 0) {
    const format = run(bin('prettier'), ['--check', '--ignore-unknown', '--', ...files], { cwd });
    if (format.status !== 0) {
      return red('prettier --check found changed files that are not formatted:', format);
    }
  }
  const ratchet = run(process.execPath, [join(tools, 'scripts', 'lint-ratchet.mjs')], {
    cwd,
    env: checkerEnv({ BASE_SHA: base }),
  });
  if (ratchet.status !== 0) return red('the lint ratchet failed:', ratchet);
  return green(`${files.length} changed file(s) lint and format clean; the ratchet holds.`);
}

/**
 * (c) Every database-bound suite registered. The manifest check reads the
 * whole tree, so it also catches a moved suite or one that newly reaches the
 * database, not only a new file.
 */
export function suiteRegistration({ cwd, tools }) {
  if (!existsSync(join(cwd, REGISTRATION))) {
    return red(
      `${REGISTRATION}, the registration check, is not in this tree. Read main's suite layout and update this gate.`,
    );
  }
  const result = vitestFile(cwd, tools, REGISTRATION);
  return result.status === 0
    ? green(`${REGISTRATION} passes.`)
    : red(
        `${REGISTRATION} fails: a database suite is neither named in the manifest nor listed as deliberately unnamed.`,
        result,
      );
}

/** (d) Subject and trailers on every commit in the range, merges included. */
export function commitTrailers({ cwd, tools, base, head }) {
  const result = run(process.execPath, [join(tools, 'scripts', 'commit-range-check.mjs')], {
    cwd,
    // CI=1: the checker refuses to fall back to its basic rule without commitlint.
    env: checkerEnv({ BASE_SHA: base, HEAD_SHA: head, CI: '1' }),
  });
  return result.status === 0
    ? green('every commit in the range carries its subject and trailers.')
    : red('a commit in the range fails its subject or trailers:', result);
}

/**
 * (e) Review evidence on the body, with the checker as `freshRef` has it. The
 * copy sits under node_modules so its own imports resolve, and is removed.
 * `openIssues` is the open issue numbers, as CI hands them to the checker.
 */
export function reviewEvidence({
  cwd,
  tools,
  freshRef,
  base,
  head,
  body,
  labels,
  changedFiles,
  agentModels,
  openIssues,
}) {
  if (body.includes('\0')) return red('the pull request body holds a NUL character; remove it.');
  if (!existsSync(join(tools, 'node_modules'))) {
    return red('node_modules is missing; run pnpm install first.');
  }
  const cache = join(tools, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'pre-ready-evidence-'));
  try {
    for (const file of FRESH) {
      let text;
      try {
        text = git(tools, 'show', `${freshRef}:scripts/${file}`);
      } catch {
        return red(
          `could not read scripts/${file} from ${freshRef}. Fetch origin main and run again.`,
        );
      }
      writeFileSync(join(dir, file), text);
    }
    const set = { PR_BODY: body, PR_LABELS: labels, HEAD_SHA: head, OPEN_ISSUES: openIssues };
    if (base !== undefined) set.BASE_SHA = base;
    if (changedFiles !== undefined) set.CHANGED_FILES = changedFiles;
    if (agentModels !== undefined) set.AGENT_MODELS = agentModels;
    const result = run(process.execPath, [join(dir, FRESH[0])], { cwd, env: checkerEnv(set) });
    return result.status === 0
      ? green(`review evidence is bound to ${short(head)} (checker from ${freshRef}).`)
      : red(
          `the pull request body fails review evidence for ${short(head)} (checker from ${freshRef}):`,
          result,
        );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** (f) No review id in a test file name or title. */
export function behaviourNames({ cwd, tools }) {
  if (!existsSync(join(cwd, NAMES))) {
    return red(`${NAMES} is not in this tree. Read main's naming check and update this gate.`);
  }
  const result = vitestFile(cwd, tools, NAMES);
  return result.status === 0
    ? green('test files and titles are named by behaviour.')
    : red(`${NAMES} fails: a test file name or title cites a review id.`, result);
}

/** (g) A trial merge with main, written to no ref and no worktree. */
export function mergeTree({ cwd, base, head }) {
  for (const ref of [base, head]) {
    const known = run('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (known.status !== 0) return red(`git merge-tree could not run: ${ref} does not resolve.`);
  }
  const result = run('git', [
    '-C',
    cwd,
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    base,
    head,
  ]);
  if (result.status === 0) return green(`merges cleanly with ${short(base)}.`);
  // -z: the tree, each conflicted path, then an empty field before the messages.
  const fields = (result.stdout ?? '').split('\0');
  const end = fields.indexOf('', 1);
  const paths = [...new Set(fields.slice(1, end === -1 ? fields.length : end))];
  if (result.status !== 1 || paths.length === 0) {
    return red(`git merge-tree could not run (exit ${result.status}):`, result);
  }
  return red(
    `conflicts with ${short(base)} in: ${paths.join(', ')}. GitHub will report this conflict, so merging main in now is allowed.`,
  );
}
