// SPDX-License-Identifier: AGPL-3.0-only
// Audit proof for the pre-ready gate (scripts/pre-ready.mjs, #950): the gate
// captures HEAD, then its changed-file lint reads the working tree. A head H
// that commits an unformatted file is run through the whole gate; once
// preflight has passed and the first changed-file oxlint call is paused, the
// file is formatted in the working tree only, and the gate is let go. The gate
// must not print green for H.
//
// The pause is a launcher in the clone's node_modules/.bin that wraps the real
// oxlint with a FIFO handshake, so no tracked file of the gate changes and no
// sleep orders the steps.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const SLOW = 600_000;
const TRAILERS = 'Assisted-by: LLM\nAgent-model: claude-opus-5-5\nAgent-tool: Claude Code';
const PLANTED = 'scripts/planted-format.mjs';

let work = '';
let tree = '';
let pause = '';
let head = '';
let gate: ChildProcess | undefined;
/** `value` as one single-quoted word for /bin/sh. */
const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const git = (...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-C',
      tree,
      '-c',
      'user.name=Gate Case',
      '-c',
      'user.email=gate-case@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();

/**
 * The clone's node_modules: every entry linked to the installed one, but
 * .bin/oxlint is a launcher that pauses once before delegating to the real one.
 */
function pausingModules(): void {
  const modules = join(tree, 'node_modules');
  mkdirSync(join(modules, '.bin'), { recursive: true });
  for (const name of readdirSync(join(root, 'node_modules'))) {
    // Dot entries (.bin, .cache, .pnpm, .vite, .vite-temp) stay out: nested runs write caches there.
    if (name.startsWith('.')) continue;
    symlinkSync(join(root, 'node_modules', name), join(modules, name));
  }
  for (const name of readdirSync(join(root, 'node_modules', '.bin'))) {
    if (name === 'oxlint') continue;
    symlinkSync(join(root, 'node_modules', '.bin', name), join(modules, '.bin', name));
  }
  execFileSync('mkfifo', [join(pause, 'paused'), join(pause, 'release')]);
  writeFileSync(
    join(modules, '.bin', 'oxlint'),
    [
      '#!/bin/sh',
      `if mkdir ${quoted(join(pause, 'once'))} 2>/dev/null; then`,
      `  echo paused > ${quoted(join(pause, 'paused'))}`,
      `  cat ${quoted(join(pause, 'release'))} > /dev/null`,
      'fi',
      `exec ${quoted(join(root, 'node_modules', '.bin', 'oxlint'))} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

/** A gh stub and a PR body for the planted head. */
function stubsAndBody(): void {
  // readOpenIssues asks gh; a stub answers with no open issues.
  mkdirSync(join(work, 'bin'));
  writeFileSync(join(work, 'bin', 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    join(work, 'body.md'),
    [
      'Reviewer: Codex',
      'Model: gpt-6-sol',
      `Head SHA: ${head}`,
      'Verdict: approve',
      '',
      'Review checkpoint',
      '  branch:      work',
      '  base:        main',
      `  head:        ${head}`,
      '  commits:     1',
      '',
      'Code review: no findings',
      '',
      `Security review: run against ${head}, no findings`,
      '',
    ].join('\n'),
  );
}

/** Each live process and its parent, from ps. */
function parents(): [number, number][] {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => {
      const [child = 0, parent = 0] = row.trim().split(/\s+/u).map(Number);
      return [child, parent];
    });
}

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
};

/**
 * Ends `pid` and everything under it in the caller's process group, so Ctrl-C
 * still reaches them: each is stopped first, so none starts another, then
 * killed. Whatever was stopped is killed even if listing the rest fails.
 */
function endTree(pid: number): void {
  const stopped = new Set<number>();
  let found = [pid];
  try {
    while (found.length > 0) {
      for (const each of found) {
        stopped.add(each);
        signal(each, 'SIGSTOP');
      }
      found = parents()
        .filter(([child, parent]) => stopped.has(parent) && !stopped.has(child))
        .map(([child]) => child);
    }
  } finally {
    for (const each of stopped) signal(each, 'SIGKILL');
  }
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'pre-ready-race-'));
  tree = join(work, 'tree');
  pause = join(work, 'pause');
  mkdirSync(pause);
  const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', root, tree]);
  // origin is the clone itself, so the gate's `git fetch origin main` makes origin/main the base.
  git('remote', 'set-url', 'origin', tree);
  git('checkout', '-q', '-B', 'main', base);
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(tree, PLANTED), 'export const sum=1+1\n');
  git('add', '--', PLANTED);
  git('commit', '-q', '--no-verify', '-m', `test: planted case\n\n${TRAILERS}`);
  head = git('rev-parse', 'HEAD');

  pausingModules();
  stubsAndBody();
}, SLOW);

afterAll(() => {
  // A failed or timed-out case leaves the gate and what it started (the
  // launcher's shell and `cat` on the FIFO, or a step's tool) running.
  try {
    if (gate?.pid !== undefined && gate.exitCode === null && gate.signalCode === null) {
      endTree(gate.pid);
    }
  } finally {
    if (work !== '') rmSync(work, { recursive: true, force: true });
  }
});

it(
  'gives no green for a head whose working tree changed mid-gate',
  async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${join(work, 'bin')}:${process.env['PATH'] ?? ''}`,
    };
    delete env['DATABASE_URL'];
    delete env['DATABASE_ADMIN_URL'];
    const child = (gate = spawn(
      process.execPath,
      [
        join(tree, 'scripts', 'pre-ready.mjs'),
        '--body-file',
        join(work, 'body.md'),
        '--skip-check',
      ],
      { cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((done) => {
      child.on('close', (code) => done(code));
    });

    // Wait until the first changed-file oxlint call pauses, after preflight.
    const paused = readFile(join(pause, 'paused'), 'utf8').then(() => 'paused' as const);
    const first = await Promise.race([paused, exited.then(() => 'exited' as const)]);
    if (first === 'exited') {
      // Frees the pending read.
      writeFileSync(join(pause, 'paused'), '');
      throw new Error(`the gate ended before oxlint paused:\n${output}`);
    }
    expect(output).toContain('pre-ready: (preflight) review preflight: green.');

    // Format the committed file in the working tree only, then release oxlint.
    writeFileSync(join(tree, PLANTED), 'export const sum = 1 + 1;\n');
    expect(git('status', '--porcelain')).toBe(`M ${PLANTED}`);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    await writeFile(join(pause, 'release'), 'go\n');
    const code = await exited;

    // H still holds the unformatted file: the gate must refuse H, not announce it green.
    expect(git('show', `${head}:${PLANTED}`)).toBe('export const sum=1+1');
    expect(output, output).not.toContain(`pre-ready: green for ${head.slice(0, 9)}`);
    expect(code, output).not.toBe(0);
  },
  SLOW,
);
