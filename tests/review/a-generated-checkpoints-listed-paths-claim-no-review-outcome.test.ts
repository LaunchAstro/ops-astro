// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const checker = resolve('scripts/review-evidence-check.mjs');
const preflight = resolve('scripts/review-preflight.mjs');
function fixture(
  path: string,
  check: (dir: string, base: string, head: string, checkpoint: string) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), 'sol1504-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'fixture-base');
    git('config', 'user.name', 'Sol proof');
    git('config', 'user.email', 'sol-proof@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.quotePath', 'true');
    writeFileSync(join(dir, 'README.md'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'fixture-work');
    mkdirSync(join(dir, 'tests/x'), { recursive: true });
    writeFileSync(join(dir, path), 'fixture\n');
    git('add', '.');
    git('commit', '-qm', 'test: fixture\n\nAgent-model: claude-opus-5-5\nAgent-model: gpt-6.1-sol');
    const head = git('rev-parse', 'HEAD');
    const output = execFileSync(process.execPath, [preflight, base], {
      cwd: dir,
      encoding: 'utf8',
    });
    check(dir, base, head, output.slice(output.indexOf('Review checkpoint')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function run(
  dir: string,
  base: string,
  head: string,
  checkpoint: string,
  labels: string,
  claim = '',
) {
  const env = { ...process.env };
  for (const key of ['CHANGED_FILES', 'AGENT_MODELS', 'RANGE_COMMITS']) delete env[key];
  return spawnSync(process.execPath, [checker], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...env,
      HEAD_SHA: head,
      BASE_SHA: base,
      PR_LABELS: labels,
      OPS_INTERNAL_STAGE1_REVIEW_DEFERRAL: 'DOMAINFIRST20261008',
      PR_BODY:
        '```\n' +
        checkpoint +
        '\n```\n\n' +
        claim +
        '\n\n' +
        `Review deferral: DOMAINFIRST20261008 internal-stage1 ${base}..${head} stage1/SOL-OWED.md`,
    },
  });
}
const both = 'unreviewed\nneeds-sol\nneeds-second-model';
test('a pasted deferral for a build by both companies owes both debt labels', () => {
  fixture('tests/x/plain.test.ts', (dir, base, head, checkpoint) => {
    expect(run(dir, base, head, checkpoint, both).status).toBe(0);
    for (const labels of ['unreviewed\nneeds-sol', 'unreviewed\nneeds-second-model']) {
      const result = run(dir, base, head, checkpoint, labels);
      expect(result.stderr).toContain('review deferral requires current labels');
      expect(result.status).toBe(1);
    }
  });
});
test('a generated checkpoint listing an ASCII approval path passes while a written approval claim refuses', () => {
  fixture('tests/x/approval-at-commit.test.ts', (dir, base, head, checkpoint) => {
    const result = run(dir, base, head, checkpoint, both);
    expect(result.status, result.stderr).toBe(0);
    const claim = run(dir, base, head, checkpoint, both, 'Approved by the reviewer.');
    expect(claim.stderr).toContain('cannot carry review outcomes, records or approval claims');
    expect(claim.status).toBe(1);
  });
});
test('a Git-quoted approval path in the generated checkpoint is not an approval claim', () => {
  fixture('tests/x/approval-café.test.ts', (dir, base, head, checkpoint) => {
    expect(checkpoint).toContain('"tests/x/approval-caf\\303\\251.test.ts"');
    const result = run(dir, base, head, checkpoint, both);
    expect(result.status, result.stderr).toBe(0);
  });
});
test('a Git-quoted line in the checkpoint that names no changed file is still an approval claim', () => {
  fixture('tests/x/approval-café.test.ts', (dir, base, head, checkpoint) => {
    const listed = '    "tests/x/approval-caf\\303\\251.test.ts"';
    const planted = checkpoint.replace(
      listed,
      `${listed}\n    "approved by the reviewer \\303\\251"`,
    );
    expect(planted).not.toBe(checkpoint);
    const result = run(dir, base, head, planted, both);
    expect(result.stderr).toContain('cannot carry review outcomes, records or approval claims');
    expect(result.status).toBe(1);
  });
});
