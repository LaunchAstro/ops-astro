// SPDX-License-Identifier: AGPL-3.0-only
// The migration ID check's own cases (METHOD step 7, lane MIG-TIMESTAMP).
//
// Each case builds a throwaway repository whose base commit holds the given
// migrations, adds or changes some on a second commit, and runs the real
// script against the two commits the way CI does. Only file names matter to
// the check, so every file holds the same statement.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** A throwaway repository on `main` with an empty `migrations/`; `done` removes it. */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'migration-ids-'));
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
  git('init', '-q', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations', '0001_m.changes.json'), '[]\n');
  /** Commit `versions` as new migrations on the current branch; returns the commit. */
  const commit = (versions, message = 'change') => {
    for (const version of versions) {
      writeFileSync(join(dir, 'migrations', `${version}.sql`), 'select 1;\n');
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const run = (base, head) =>
    spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: head },
    });
  return { dir, git, commit, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run the check over a base holding `base` and a head that adds `added`. */
function check(base, added) {
  const repo = repository();
  try {
    const baseSha = repo.commit(base, 'base');
    return repo.run(baseSha, repo.commit(added));
  } finally {
    repo.done();
  }
}

/**
 * A merge queue group on `base` (holding `main`): one queue merge per pull
 * request, in order, each pull request branched from `base` and adding its
 * migrations. Returns the check's run over the base and the group's head.
 */
function group(main, pulls) {
  const repo = repository();
  try {
    const base = repo.commit(main, 'base');
    const heads = pulls.map((added, i) => {
      repo.git('checkout', '-q', '-b', `pr-${String(i + 1)}`, base);
      return repo.commit(added);
    });
    repo.git('checkout', '-q', '-b', 'queue', base);
    for (const [i, head] of heads.entries()) {
      repo.git(
        'merge',
        '-q',
        '--no-ff',
        '-m',
        `Merge pull request #${String(i + 1)} from x/pr`,
        head,
      );
    }
    return repo.run(base, repo.git('rev-parse', 'HEAD'));
  } finally {
    repo.done();
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
    '19990101000000_last_century',
    '01000101000000_year_100',
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

test('refuses a queue group whose later entry adds a migration below an earlier one', () => {
  // B wrote its migration first but queued second: main would stand at A's
  // migration, then apply B's below it, the other order from a fresh install.
  const main = [...MAIN_AFTER_3A, '20261002000000_on_main'];
  refuses(
    group(main, [['20261002020000_a'], ['20261002010000_b']]),
    /20261002010000_b sorts before 20261002020000_a/u,
  );
  passes(group(main, [['20261002010000_b'], ['20261002020000_a']]));
});

test('refuses two queue entries that add the same ID', () => {
  refuses(group(MAIN_AFTER_3A, [['0100_one'], ['0100_two']]), /0100_one and 0100_two/u);
});

test("judges a pull request's merge against main as it now stands, not the event's older base", () => {
  const repo = repository();
  try {
    const stale = repo.commit(MAIN_AFTER_3A, 'base');
    repo.git('checkout', '-q', '-b', 'pr', stale);
    const pr = repo.commit(['20261002020000_pr']);
    repo.git('checkout', '-q', 'main');
    repo.commit(['20261002030000_main_moved']);
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge pr into main', pr);
    refuses(
      repo.run(stale, repo.git('rev-parse', 'HEAD')),
      /20261002020000_pr sorts before 20261002030000_main_moved/u,
    );
  } finally {
    repo.done();
  }
});

test('refuses a head that merged main in with no merge on top, judged against main', () => {
  const repo = repository();
  try {
    const before = repo.commit(MAIN_AFTER_3A, 'base');
    repo.git('checkout', '-q', '-b', 'branch', before);
    repo.commit(['20261001000000_t1']);
    repo.git('checkout', '-q', 'main');
    const main = repo.commit(['20261001120000_t2']);
    repo.git('checkout', '-q', 'branch');
    repo.git('merge', '-q', '--no-ff', '-m', 'merge main in', 'main');
    refuses(
      repo.run(main, repo.git('rev-parse', 'HEAD')),
      /20261001000000_t1 sorts before 20261001120000_t2/u,
    );
  } finally {
    repo.done();
  }
});

test('refuses a migration that is not a regular file, such as a symlink', () => {
  const repo = repository();
  try {
    const base = repo.commit(MAIN_AFTER_3A, 'base');
    writeFileSync(join(repo.dir, 'elsewhere.sql'), 'select 1;\n');
    symlinkSync('../elsewhere.sql', join(repo.dir, 'migrations', '20261002013000_link.sql'));
    refuses(repo.run(base, repo.commit([])), /20261002013000_link is not a regular file/u);
  } finally {
    repo.done();
  }
});

test('refuses a name holding a tab, judging the whole name and not the text before the tab', () => {
  // Cut at the tab, the name would read as `<stamp>_abcd`, well formed.
  refuses(check(MAIN_AFTER_3A, [`${stamp(0)}_abcdefgh\t`]), /abcdefgh/u);
});

test('refuses a .SQL name, which the runner skips on Linux and a Mac folds onto .sql', () => {
  const repo = repository();
  try {
    const base = repo.commit(MAIN_AFTER_3A, 'base');
    writeFileSync(join(repo.dir, 'migrations', `${stamp(0)}_shout.SQL`), 'select 1;\n');
    refuses(repo.run(base, repo.commit([])), /_shout\.SQL/u);
  } finally {
    repo.done();
  }
});

test('refuses a .SQL twin of an applied migration, which replaces it on a Mac checkout', () => {
  const repo = repository();
  try {
    const base = repo.commit(MAIN_AFTER_3A, 'base');
    const blob = repo.git('rev-parse', `${base}:migrations/0001_m.sql`);
    repo.git('update-index', '--add', '--cacheinfo', `100644,${blob},migrations/0001_m.SQL`);
    repo.git('commit', '-q', '-m', 'twin');
    refuses(repo.run(base, repo.git('rev-parse', 'HEAD')), /0001_m\.SQL/u);
  } finally {
    repo.done();
  }
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
