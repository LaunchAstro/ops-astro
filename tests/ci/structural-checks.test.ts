// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-STRUCT (speed audit fix 2.3): the structural checks judge a pull request's head merged into
// main as main stands when the job runs, not as it stood when the head was pushed. The cases run
// the real script and the real lint ratchet in a throwaway origin and clone: the pull request
// branched from an older main, and main moved after, the way #819 and #379 left the queue.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/structural-checks.ts');
const RATCHET = join(ROOT, 'scripts/lint-ratchet.mjs');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/structural.yml');
const WORKFLOW = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, 'utf8') : '';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// As on a runner: no identity and no signing from this machine's own git settings.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** `n` lines of plain declarations, each named from `tag`. */
const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `export const ${tag}${String(i)} = ${String(i)};\n`).join('');

/** Writes `files` in `dir` and commits them; returns the commit. */
function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  git(dir, ...IDENTITY, 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** An origin whose main holds a 990-line product file, and a clone of it. */
function world(): { origin: string; clone: string; base: string } {
  const origin = mkdtempSync(join(tmpdir(), 'ci-struct-origin-'));
  const clone = mkdtempSync(join(tmpdir(), 'ci-struct-clone-'));
  made.push(origin, clone);
  git(origin, 'init', '-q', '-b', 'main');
  const base = commit(
    origin,
    {
      'apps/x.ts': lines(990, 'a'),
      'apps/y.ts': lines(3, 'y'),
      'lint-baseline.json': `${JSON.stringify({ rules: {} })}\n`,
    },
    'base',
  );
  git(clone, 'clone', '-q', origin, '.');
  return { origin, clone, base };
}

/** A pull request branch in the clone, off the main it was cloned at; returns its head. */
function pull(clone: string, files: Record<string, string>): string {
  git(clone, 'checkout', '-q', '-b', 'pr');
  return commit(clone, files, 'pull request');
}

function script(cwd: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout.trim(), out: `${run.stdout}${run.stderr}` };
}

function ratchet(cwd: string, base: string) {
  const env = { ...ENV, BASE_SHA: base, GITHUB_BASE_REF: '' };
  const run = spawnSync(process.execPath, [RATCHET], { cwd, env, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('CI-STRUCT structural checks against main as it stands', () => {
  it('a head under the cap alone, over it once merged into the main that moved, fails', () => {
    const { origin, clone, base } = world();
    const head = pull(clone, { 'apps/x.ts': lines(990, 'a') + lines(8, 'p') });
    // What the pull request's own check saw: 998 lines, green.
    expect(ratchet(clone, base).status).toBe(0);
    // Main moves: another pull request adds 8 lines at the top of the same file.
    const tip = commit(origin, { 'apps/x.ts': lines(8, 'm') + lines(990, 'a') }, 'main moves');

    const merged = script(clone, 'merge', head, 'main');
    expect(merged.status, merged.out).toBe(0);
    expect(merged.stdout).toBe(tip);
    expect(readFileSync(join(clone, 'apps/x.ts'), 'utf8').split('\n')).toHaveLength(1007);

    const run = script(clone, 'run', tip, 'lint-ratchet');
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('apps/x.ts: 1006 lines, over the 1000-line limit');
    expect(run.out).toMatch(/FAIL {2}lint-ratchet/u);
  });

  it('a head that stays clean merged into the main that moved passes', () => {
    const { origin, clone } = world();
    const head = pull(clone, { 'apps/y.ts': lines(3, 'y') + lines(2, 'q') });
    const tip = commit(origin, { 'apps/x.ts': lines(8, 'm') + lines(990, 'a') }, 'main moves');

    const merged = script(clone, 'merge', head, 'main');
    expect(merged.status, merged.out).toBe(0);
    expect(merged.stdout).toBe(tip);
    const run = script(clone, 'run', tip, 'lint-ratchet');
    expect(run.status, run.out).toBe(0);
    expect(run.out).toMatch(/pass {2}lint-ratchet/u);
  });

  it('a head that conflicts with main fails, naming the file, and leaves no half merge', () => {
    const { origin, clone } = world();
    const head = pull(clone, { 'apps/y.ts': 'export const theirs = 1;\n' });
    commit(origin, { 'apps/y.ts': 'export const ours = 2;\n' }, 'main moves');

    const merged = script(clone, 'merge', head, 'main');
    expect(merged.status).toBe(1);
    expect(merged.out).toMatch(/conflicts with main at [0-9a-f]{40}: apps\/y\.ts/u);
    expect(git(clone, 'status', '--porcelain')).toBe('');
  });
});

describe('CI-STRUCT structural checks refuse what they cannot judge', () => {
  it('a check it does not know fails and names the three it runs', () => {
    const { clone, base } = world();
    const run = script(clone, 'run', base, 'nope');
    expect(run.status).toBe(1);
    expect(run.out).toContain('the checks are lint-ratchet, cq-8, db-shards');
  });

  it('a base or head that is not a full commit id is refused before git reads it', () => {
    const { clone, base } = world();
    expect(script(clone, 'merge', '--upload-pack=x', 'main').status).toBe(1);
    expect(script(clone, 'merge', base, '-x').status).toBe(1);
    expect(script(clone, 'run', 'main').status).toBe(1);
  });
});

/** The lines under `key` at `indent` spaces, up to the next line indented no deeper. */
const block = (text: string, key: string, indent = 0): string => {
  const start = text.indexOf(`\n${' '.repeat(indent)}${key}:`);
  if (start === -1) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(new RegExp(`\\n {0,${String(indent)}}\\S`, 'u'));
  return (next === -1 ? rest : rest.slice(0, next + 1)).replace(/\n+$/u, '\n');
};

describe('CI-STRUCT the workflow', () => {
  const check = block(WORKFLOW, 'structural', 2);
  const recheck = block(WORKFLOW, 'recheck', 2);

  it('the check carries the name the train reads, and runs every check on the merged tree', () => {
    expect(check).toContain('    name: structural checks (vs current main)\n');
    expect(check).toContain("if: github.event_name != 'push'");
    expect(check).toMatch(/node scripts\/structural-checks\.ts merge "\$HEAD_SHA" main/u);
    // No names after the base: all three run.
    expect(check).toMatch(
      /node scripts\/structural-checks\.ts run "\$\(cat "\$RUNNER_TEMP\/base"\)"\n/u,
    );
  });

  it('it runs on a pull request, a group, a dispatch and a push to main, never pull_request_target', () => {
    const on = block(WORKFLOW, 'on');
    for (const event of ['pull_request', 'merge_group', 'workflow_dispatch', 'push'])
      expect(on).toMatch(new RegExp(`^ {2}${event}:`, 'mu'));
    expect(WORKFLOW).not.toContain('pull_request_target');
    expect(WORKFLOW).not.toContain('workflow_run');
    expect(WORKFLOW).not.toMatch(/secrets\./u);
  });

  it('the token reads contents only, and only the re-check, which runs no repository code, may dispatch', () => {
    expect(block(WORKFLOW, 'permissions')).toBe('permissions:\n  contents: read\n');
    expect(check).not.toContain('permissions:');
    expect(check).toContain('persist-credentials: false');
    expect(block(recheck, 'permissions', 4)).toBe(
      '    permissions:\n      actions: write\n      pull-requests: read\n',
    );
    expect(recheck).toContain("if: github.event_name == 'push'");
    expect(recheck).not.toMatch(/uses:|node |pnpm /u);
    expect(WORKFLOW.match(/: write$/gmu)).toHaveLength(1);
  });
});
