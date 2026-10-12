// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const checker = resolve(import.meta.dirname, '../../scripts/public-content-check.mjs');
const approved = ['ada', '@', 'alpha.local'].join('');

test('filename emphasis cannot exempt an unlisted complete address', () => {
  const repo = mkdtempSync(join(tmpdir(), 'address-framing-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Gate Test');
    git('config', 'user.email', 'gate@example.invalid');
    // '*' is valid local-part punctuation. A filename has no Markdown emphasis.
    writeFileSync(join(repo, `*${approved}*.txt`), 'neutral bytes\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'neutral note');
    const scan = spawnSync(process.execPath, [checker, '--repo', repo, '--range', 'HEAD'], {
      encoding: 'utf8',
    });
    assert.equal(scan.status, 1, scan.stdout + scan.stderr);
    assert.match(scan.stderr, /<withheld-path> \[contributor-address\]/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('doubled filename emphasis cannot exempt an unlisted complete address', async () => {
  const { scanPublicFiles } = await import(checker);
  const filename = `**${approved}**.txt`;
  const findings = scanPublicFiles([{ path: filename, bytes: Buffer.from('neutral bytes\n') }]);
  assert.ok(
    findings.some(({ rule }) => rule === 'contributor-address'),
    'leading atext punctuation belongs to the complete address in a filename',
  );
});
