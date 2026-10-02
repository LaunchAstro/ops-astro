// SPDX-License-Identifier: AGPL-3.0-only
// The migration ID check's own cases (METHOD step 7, lane MIG-TIMESTAMP).
//
// Each case builds a throwaway repository whose base commit holds the given
// migrations, adds or changes some on a second commit, and runs the real
// script against the two commits the way CI does. Only file names matter to
// the check, so every file holds the same statement.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../..');
const script = join(repoRoot, 'scripts/migration-ids.mjs');

const numbered = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(4, '0')}_m`);

/** Main once batch 3a (#324) has landed: 0001 to 0099. */
const MAIN_AFTER_3A = numbered(1, 99);

/** Batch 3b (#327) as it lands after this check, on b3integ 5e293e3: 0100 to 0111. */
const BATCH_3B = [
  '0100_delegation_children',
  '0101_child_work_events',
  '0102_plan_records',
  '0103_trace_expiry',
  '0104_model_call_caller',
  '0105_planned_step_plan_key',
  '0106_outage_audit_copy_missing',
  '0107_planning_envelopes',
  '0108_reviewed_outputs',
  '0109_attempt_receipt_link',
  '0110_provider_faults',
  '0111_reviewed_output_proposer',
];

/** A UTC timestamp ID `hours` from now, to the second. */
const stamp = (hours) =>
  new Date(Date.now() + hours * 3_600_000).toISOString().replaceAll(/[-:T]/gu, '').slice(0, 14);

/** Run the check over a base holding `base` and a head that adds `added`. */
function check(base, added) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-ids-'));
  try {
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'case',
          GIT_AUTHOR_EMAIL: 'case@example.invalid',
          GIT_COMMITTER_NAME: 'case',
          GIT_COMMITTER_EMAIL: 'case@example.invalid',
        },
      }).trim();
    const write = (version) =>
      writeFileSync(join(dir, 'migrations', `${version}.sql`), 'select 1;\n');
    git('init', '-q', '-b', 'main');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, 'migrations'));
    for (const version of base) write(version);
    writeFileSync(join(dir, 'migrations', '0001_m.changes.json'), '[]\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    for (const version of added) write(version);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'change');
    const headSha = git('rev-parse', 'HEAD');
    return spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: baseSha, HEAD_SHA: headSha },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const passes = (run) => assert.equal(run.status, 0, run.stdout + run.stderr);
const refuses = (run, ...named) => {
  assert.equal(run.status, 1, run.stdout + run.stderr);
  for (const pattern of named) assert.match(run.stderr, pattern);
};

test("accepts batch 3b's sequential 0100 to 0111 landing on 3a's 0099", () => {
  passes(check(MAIN_AFTER_3A, BATCH_3B));
});

test("accepts a UTC timestamp ID after main's newest sequential one", () => {
  passes(check(MAIN_AFTER_3A, ['20261002013000_first_stamped']));
});

test('accepts a timestamp after a timestamp, and a change that adds no migration', () => {
  const main = [...MAIN_AFTER_3A, '20261002013000_first_stamped'];
  passes(check(main, ['20261002020000_second_stamped']));
  passes(check(main, []));
});

test('refuses a planted duplicate ID, naming both files', () => {
  // #315 lands 0084_task_category; #331 carries 0084 as a placeholder.
  refuses(
    check(numbered(1, 83), ['0084_task_category', '0084_second_factor_codes_retention']),
    /0084_second_factor_codes_retention/u,
    /0084_task_category/u,
    /same ID/u,
  );
});

test('refuses a duplicate of an ID already on main', () => {
  refuses(check(MAIN_AFTER_3A, ['0099_late_copy']), /0099_late_copy/u, /same ID/u);
  const main = [...MAIN_AFTER_3A, '20261002013000_first_stamped'];
  refuses(check(main, ['20261002013000_twin']), /20261002013000_twin/u, /same ID/u);
});

test("refuses a planted out-of-order ID, one that sorts before main's newest", () => {
  const main = [...MAIN_AFTER_3A, '20261002013000_first_stamped'];
  refuses(
    check(main, ['20261001120000_written_earlier']),
    /20261001120000_written_earlier sorts before 20261002013000_first_stamped/u,
  );
  // A sequential number after main has moved to timestamps sorts before them too.
  refuses(check(main, ['0100_late_number']), /0100_late_number sorts before/u);
});

test('refuses a gap in the sequential range, such as a placeholder left unconverted', () => {
  refuses(
    check(MAIN_AFTER_3A, ['0342_conversation_admission']),
    /0342_conversation_admission/u,
    /no gap/u,
  );
});

test('refuses a name that is neither a four-digit number nor a UTC timestamp', () => {
  for (const name of [
    '84_short',
    '00084_long',
    '2026-10-02_dashes',
    '202610020130_minutes_only',
    '20261302013000_month_13',
    '20261002246000_minute_60',
    '0100_Upper_Case',
    '0100-dash',
    'loose',
  ]) {
    refuses(check(MAIN_AFTER_3A, [name]), new RegExp(name, 'u'));
  }
});

test('refuses a timestamp ahead of the clock, as local time written for UTC would be', () => {
  // Townsville is UTC+10: its wall clock read as UTC is ten hours ahead.
  refuses(check(MAIN_AFTER_3A, [`${stamp(10)}_local_time`]), /ahead of the clock/u);
  passes(check(MAIN_AFTER_3A, [`${stamp(0)}_just_now`]));
});

test('needs both commits, as migrations-unchanged does', () => {
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, BASE_SHA: '', HEAD_SHA: '' },
  });
  assert.equal(run.status, 2, run.stdout + run.stderr);
});

test('runs in the required commits job on the head CI checked out, before approval and in the queue', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const job = workflow.slice(
    workflow.indexOf('\n  commits:\n'),
    workflow.indexOf('\n  pr-size:\n'),
  );
  assert.match(job, /if: github\.event_name != 'push'/u);
  assert.ok(
    job.includes(
      'BASE_SHA="$(node scripts/merge-group.mjs base)" HEAD_SHA="$(git rev-parse HEAD)" node scripts/migration-ids.mjs',
    ),
    job,
  );
  assert.ok(job.includes('node --test tests/ci/migration-ids-cases.mjs'), job);
});
