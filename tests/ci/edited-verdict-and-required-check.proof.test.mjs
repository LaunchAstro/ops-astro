// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const head = 'a'.repeat(40);
const body = (verdict) => `Reviewer: Sol (Codex)\nHead SHA: ${head}\nVerdict: ${verdict}`;

test('an edited formal refusal supersedes a later positive comment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edited-verdict-'));
  try {
    writeFileSync(
      join(dir, 'comments.json'),
      JSON.stringify([
        {
          user: { login: 'fixture-reviewer' },
          body: body('approve'),
          updated_at: '2026-10-01T01:00:00Z',
        },
      ]),
    );
    writeFileSync(
      join(dir, 'reviews.json'),
      JSON.stringify([
        {
          user: { login: 'fixture-reviewer' },
          body: body('changes requested'),
          submitted_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T02:00:00Z',
        },
      ]),
    );
    const out = spawnSync(
      process.execPath,
      [join(root, 'scripts/sol-verdict-check.mjs'), '--records', dir],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PR_NUMBER: '11',
          HEAD_SHA: head,
          PR_LABELS: 'needs-sol',
          SOL_REVIEWER_ACCOUNT: 'fixture-reviewer',
        },
      },
    );
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stderr, /the newest record must contain/u);
    assert.doesNotMatch(out.stderr, /MODULE_NOT_FOUND/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workflow self-test permits its context to become required', () => {
  const dir = mkdtempSync(join(tmpdir(), 'required-verdict-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(join(dir, 'tests/ci'), { recursive: true });
    for (const file of ['.github/workflows/sol-verdict.yml', 'tests/ci/verdict-workflow.test.mjs'])
      copyFileSync(join(root, file), join(dir, file));
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const manifest = JSON.parse(readFileSync(join(root, '.github/required-checks.json'), 'utf8'));
    manifest.required_status_checks.push({
      context: 'Sol verdict for this revision',
      integration_id: 15368,
    });
    writeFileSync(join(dir, '.github/required-checks.json'), JSON.stringify(manifest));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const out = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=spec',
        '--test-name-pattern=job runs on pull requests',
        join(dir, 'tests/ci/verdict-workflow.test.mjs'),
      ],
      { encoding: 'utf8', env },
    );
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /pass 1/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
