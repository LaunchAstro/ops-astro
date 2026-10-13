// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const head = 'a'.repeat(40);
const account = 'fixture-reviewer';
const record = (
  body = `Reviewer: Sol (Codex)\nHead SHA: ${head}\nVerdict: approve`,
  extra = {},
) => ({
  id: 1,
  user: { login: account },
  body,
  created_at: '2026-10-01T01:00:00Z',
  updated_at: '2026-10-01T01:00:00Z',
  ...extra,
});

function run({
  comments = [record()],
  reviews = [],
  labels = 'needs-sol',
  sha = head,
  reviewer = account,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-record-'));
  try {
    writeFileSync(join(dir, 'comments.json'), JSON.stringify(comments));
    writeFileSync(join(dir, 'reviews.json'), JSON.stringify(reviews));
    return spawnSync(process.execPath, ['scripts/sol-verdict-check.mjs', '--records', dir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PR_NUMBER: '11',
        HEAD_SHA: sha,
        PR_LABELS: labels,
        SOL_REVIEWER_ACCOUNT: reviewer,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('passes an exact full head from the configured account', () => {
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /#11.*pass/u);
});

for (const [name, body, extra] of [
  [
    'refuses an abbreviated head',
    `Reviewer: Sol (Codex)\nHead SHA: ${head.slice(0, 12)}\nVerdict: approve`,
    {},
  ],
  [
    'refuses a different full head',
    `Reviewer: Sol (Codex)\nHead SHA: ${'b'.repeat(40)}\nVerdict: approve`,
    {},
  ],
  [
    'refuses a lookalike identity',
    `Reviewer: Solomon (Other)\nHead SHA: ${head}\nVerdict: approve`,
    {},
  ],
  [
    'refuses copied text from a different author',
    undefined,
    { user: { login: 'fixture-builder' } },
  ],
]) {
  test(name, () => {
    const out = run({ comments: [record(body, extra)] });
    assert.equal(out.status, 1, out.stdout + out.stderr);
  });
}

for (const verdict of ['unreadable', 'changes requested', '']) {
  test(`refuses a newer ${verdict || 'missing'} verdict over an earlier positive record`, () => {
    const newer = record(
      `Reviewer: Sol (Codex)\nHead SHA: ${head}\n${verdict ? `Verdict: ${verdict}` : ''}`,
      {
        id: 2,
        created_at: '2026-10-01T02:00:00Z',
        updated_at: '2026-10-01T02:00:00Z',
      },
    );
    const out = run({ comments: [record(), newer] });
    assert.equal(out.status, 1, out.stdout + out.stderr);
  });
}

test('passes as not applicable when the label is absent', () => {
  const out = run({ comments: [], labels: 'needs-second-model\nunreviewed', reviewer: '' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /not applicable/u);
});

test('a formal review can supersede a comment regardless of endpoint ordering', () => {
  const out = run({
    comments: [record()],
    reviews: [
      record(`Reviewer: Sol (Codex)\nHead SHA: ${head}\nVerdict: changes requested`, {
        id: 2,
        submitted_at: '2026-10-01T02:00:00Z',
      }),
    ],
  });
  assert.equal(out.status, 1, out.stdout + out.stderr);
});

test('a newer positive comment supersedes an earlier negative formal review', () => {
  const out = run({
    reviews: [
      record(`Reviewer: Sol (Codex)\nHead SHA: ${head}\nVerdict: changes requested`, {
        id: 2,
        submitted_at: '2026-10-01T00:00:00Z',
      }),
    ],
  });
  assert.equal(out.status, 0, out.stderr);
});

test('an edited comment is judged at its update time', () => {
  const out = run({
    comments: [
      record(),
      record(`Reviewer: Sol (Codex)\nHead SHA: ${head}\nVerdict: changes requested`, {
        id: 2,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T03:00:00Z',
      }),
    ],
  });
  assert.equal(out.status, 1, out.stdout + out.stderr);
});

for (const [name, options] of [
  ['refuses when the configured account is missing', { reviewer: '' }],
  ['refuses when the judged head is abbreviated', { sha: head.slice(0, 7) }],
  [
    'refuses an ambiguous timestamp across record sources',
    { reviews: [record(undefined, { submitted_at: '2026-10-01T01:00:00Z' })] },
  ],
  [
    'refuses a record with no usable timestamp',
    { comments: [record(undefined, { updated_at: null })] },
  ],
  ['refuses an unreadable records response', { comments: { message: 'failed read' } }],
  [
    'refuses a newer quoted record over earlier evidence',
    {
      comments: [
        record(),
        record(`> Reviewer: Sol (Codex)\n> Head SHA: ${head}\n> Verdict: approve`, {
          updated_at: '2026-10-01T02:00:00Z',
        }),
      ],
    },
  ],
  [
    'refuses duplicated verdict fields',
    {
      comments: [
        record(
          `Reviewer: Sol (Codex)\nHead SHA: ${head}\nVerdict: approve\nVerdict: changes requested`,
        ),
      ],
    },
  ],
]) {
  test(name, () => {
    const out = run(options);
    assert.equal(out.status, 1, out.stdout + out.stderr);
  });
}

test('ignores unrelated conversation from the configured account', () => {
  const out = run({
    comments: [
      record(),
      record('Thanks, rerunning the tests.', { updated_at: '2026-10-01T02:00:00Z' }),
    ],
  });
  assert.equal(out.status, 0, out.stderr);
});

test('untrusted text cannot replace the configured account record', () => {
  const out = run({
    comments: [
      record(),
      record(`Reviewer: Sol (Codex)\nHead SHA: ${head}\nVerdict: changes requested`, {
        updated_at: '2026-10-01T02:00:00Z',
        user: { login: 'fixture-builder' },
      }),
    ],
  });
  assert.equal(out.status, 0, out.stderr);
});

for (const [name, comments] of [
  [
    'refuses a newer record for another full head',
    [
      record(),
      record(`Reviewer: Sol (Codex)\nHead SHA: ${'b'.repeat(40)}\nVerdict: approve`, {
        updated_at: '2026-10-01T02:00:00Z',
      }),
    ],
  ],
  ['refuses a dismissed formal review', []],
]) {
  test(name, () => {
    const out = run({
      comments,
      reviews:
        comments.length > 0
          ? []
          : [record(undefined, { submitted_at: '2026-10-01T02:00:00Z', state: 'DISMISSED' })],
    });
    assert.equal(out.status, 1, out.stdout + out.stderr);
  });
}

test('compares GitHub account names without case sensitivity', () => {
  const out = run({ reviewer: 'FIXTURE-REVIEWER' });
  assert.equal(out.status, 0, out.stderr);
});

test('a missing record file refuses instead of using old evidence', () => {
  const out = spawnSync(
    process.execPath,
    ['scripts/sol-verdict-check.mjs', '--records', 'absent-fixture-records'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PR_NUMBER: '11',
        HEAD_SHA: head,
        PR_LABELS: 'needs-sol',
        SOL_REVIEWER_ACCOUNT: account,
      },
    },
  );
  assert.equal(out.status, 1);
  assert.match(out.stderr, /cannot read verdict records/u);
});
