// SPDX-License-Identifier: AGPL-3.0-only
//
// The review checkpoint is printed only from a ticket's own branch: never
// from main ahead of origin/main, and never from a detached head at the same
// commit (AGENTS.md, one branch per ticket).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PREFLIGHT = resolve(import.meta.dirname, '../../scripts/review-preflight.mjs');
const repo = mkdtempSync(join(tmpdir(), 'review-preflight-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'fixture@example.invalid');
git('config', 'user.name', 'fixture');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'a.txt'), 'one\n');
git('add', 'a.txt');
git('commit', '-qm', 'base');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
writeFileSync(join(repo, 'a.txt'), 'two\n');
git('commit', '-qam', 'the change');
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const preflight = () =>
  spawnSync(process.execPath, [PREFLIGHT, 'origin/main'], { cwd: repo, encoding: 'utf8' });

describe('review preflight', () => {
  it('refuses main ahead of origin/main', () => {
    git('switch', '-q', 'main');
    expect(preflight().status).toBe(1);
  });

  it('refuses a detached head at the same commit', () => {
    git('switch', '-q', '--detach', 'main');
    const result = preflight();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toMatch(/detached/u);
  });

  it('prints the checkpoint from a ticket branch at the same commit', () => {
    git('switch', '-q', '-c', 'ticket', 'main');
    const result = preflight();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('branch:      ticket');
  });
});
