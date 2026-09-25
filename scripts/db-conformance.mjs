// SPDX-License-Identifier: AGPL-3.0-only
// The named suites, run against a real database, with silence treated as
// failure.
//
// Item 6 of the PG0 product ticket: a hosted job that fails on any database
// skip. The failure it exists to prevent is not a red run. It is a green one
// that proves nothing: a suite that was never found, a test that quietly
// skipped because no database was configured, or a run in which zero database
// tests executed at all. Every one of those leaves a green tick beside the
// words "database conformance", and every one of them is a lie.
//
// So a green from this runner means all of:
//
//   1. DATABASE_URL is set and the database answers;
//   2. the manifest names at least one suite;
//   3. every named suite exists on disk;
//   4. the suites ran, and more than zero tests executed;
//   5. no test was skipped or marked todo;
//   6. no test failed;
//   7. the database's own transaction counter moved while each named suite
//      ran, so every one of them reached it rather than passing beside it;
//   8. every suite the manifest names appears in vitest's report, with tests
//      of its own that ran;
//   9. vitest itself reported nothing wrong: its process exited zero without a
//      signal, and its report carries no error of its own.
//
// Rules 8 and 9 close two greens that rules 4 to 6 cannot see, because both
// read aggregates. A manifest can name a file that exists on disk and sits
// outside vitest's discovery: it is never loaded, the other named suites
// supply the counts, and the run is green over a suite that did not run. And
// vitest can end a run in failure -- an unhandled rejection is the plain case
// -- while every test it counted passed, so the counts say nothing is wrong
// and the process exit status says otherwise.
//
// Rule 7 is the one that catches the interesting case. A suite can pass with
// every database assertion commented out, and rules 4 to 6 will not notice.
// The counter is read from pg_stat_database, and the runner measures what its
// own reads cost before it uses the number, so the threshold is calibrated
// rather than guessed.
//
// Round nine, 23 September, found rule 7 counting the whole run. One suite
// reaching the database moved the counter for all of them, so a named suite
// holding nothing but `expect(1 + 1).toBe(2)` passed on a sibling's
// transactions. A counter read around the whole run cannot say which suite
// moved it, so each named suite is now run on its own with the counter read
// either side. That is what binds database activity to a path rather than to
// a total, and it is why the runner spawns vitest once per suite.
//
// Usage: node scripts/db-conformance.mjs [--manifest <path>]
//   DATABASE_URL  the database to run against. Required.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import pg from 'pg';

const repoRoot = resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const manifestFlag = argv.indexOf('--manifest');
const manifestPath = resolve(
  manifestFlag === -1 ? join(repoRoot, 'tests/db/named-suites.json') : argv[manifestFlag + 1],
);

const url = (process.env['DATABASE_URL'] ?? '').trim();
if (url === '') {
  console.error('db-conformance: DATABASE_URL must be set.');
  console.error('db-conformance: this check exists to prove the suites reached a database.');
  console.error('db-conformance: running it without one is the thing it refuses.');
  process.exit(2);
}

if (!existsSync(manifestPath)) {
  console.error(`db-conformance: no suite manifest at ${manifestPath}.`);
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`db-conformance: cannot read ${manifestPath}: ${String(error)}`);
  process.exit(2);
}

const named = [
  ...(Array.isArray(manifest.invariant) ? manifest.invariant : []),
  ...(Array.isArray(manifest.conformance) ? manifest.conformance : []),
].map(String);

const failures = [];

// 2. A manifest that names nothing is not a passing run.
if (named.length === 0) {
  failures.push(
    'the manifest names no suite.\n' +
      `        ${manifestPath}\n` +
      '        A database gate with nothing to run is not a gate. Name the\n' +
      "        part's invariant suite and the conformance suites its change\n" +
      '        affects. Until one exists, this check fails, and it is meant to.',
  );
}

// 3. A named suite that is not there is the quietest failure of the lot.
const missing = named.filter((suite) => !existsSync(join(repoRoot, suite)));
if (missing.length > 0) {
  failures.push(
    'the manifest names suites that are not on disk:\n' +
      missing.map((s) => `          ${s}`).join('\n') +
      '\n        A suite that cannot be found does not run, and a run that did\n' +
      '        not happen must not report green.',
  );
}

/** The first line of a message, for a failure list that stays readable. */
const firstLine = (value) =>
  String(value ?? '')
    .split('\n')[0]
    .trim();

/** The database's committed and rolled-back transaction count. */
const readCounter = async (client) => {
  const { rows } = await client.query(
    'select xact_commit + xact_rollback as n from pg_stat_database where datname = current_database()',
  );
  return Number(rows[0]?.n ?? 0);
};

const client = new pg.Client({ connectionString: url });
let selfCost = 0;

try {
  await client.connect();
  // Two consecutive reads measure what a read of the counter costs, so the
  // threshold below is calibrated on this database rather than assumed. The
  // same pair of reads brackets each suite, so the cost is the same one.
  const first = await readCounter(client);
  const second = await readCounter(client);
  selfCost = Math.max(1, second - first);
} catch (error) {
  console.error(`db-conformance: the database named by DATABASE_URL did not answer.`);
  console.error(`db-conformance: ${String(error)}`);
  await client.end().catch(() => {});
  process.exit(1);
}

let ran = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };

const vitestBin = join(repoRoot, 'node_modules/vitest/vitest.mjs');

// A literal path as a glob, so an exclusion names that file and no other.
const literal = (path) => path.replace(/[*?[\]{}()!+@\\]/gu, '\\$&');

/**
 * Every file vitest would run for this suite other than the suite itself.
 * Round ten, 24 September, found vitest reading a path as a substring
 * filter: naming `invariant.test.ts` also ran `invariant.test.ts.db.test.ts`,
 * so a sibling's transactions moved the counter this suite is measured by.
 * vitest has no exact-path filter, so it is asked what the filter selects,
 * without loading any of it, and everything else it names is excluded.
 */
const siblingsOf = (suite) => {
  const listed = spawnSync(process.execPath, [vitestBin, 'list', '--filesOnly', suite], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });
  return (listed.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && resolve(repoRoot, line) !== resolve(repoRoot, suite))
    .map((line) => literal(relative(repoRoot, resolve(repoRoot, line))));
};

/**
 * One vitest run over one named suite, with the database's counter read
 * either side of it. Running the suites together made rule 7 a whole-run
 * number that no suite owned; running them one at a time is what gives each
 * path a transaction count of its own.
 */
const runSuite = async (suite) => {
  // vitest's JSON reporter writes to a file, never to stdout, so the report
  // is collected from one and removed afterwards.
  const reportPath = join(mkdtempSync(join(tmpdir(), 'hub-db-conformance-')), 'report.json');
  // A read that fails is not a measurement. Copilot on PR A: substituting
  // zero for a failed pre-suite read turned the cumulative counter into a
  // movement, and a suite that never touched the database passed rule 7.
  // Either read failing leaves the suite unmeasured, and that fails the run.
  let before = 0;
  let readError;
  try {
    before = await readCounter(client);
  } catch (error) {
    readError = error;
  }
  const run = spawnSync(
    process.execPath,
    [
      vitestBin,
      'run',
      '--reporter=json',
      `--outputFile=${reportPath}`,
      ...siblingsOf(suite).map((path) => `--exclude=${path}`),
      suite,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url, CI: 'true' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  let after = before;
  if (readError === undefined) {
    try {
      after = await readCounter(client);
    } catch (error) {
      readError = error;
    }
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = undefined;
  } finally {
    rmSync(join(reportPath, '..'), { recursive: true, force: true });
  }
  return { suite, run, report, moved: after - before, readError };
};

const results = [];

if (failures.length === 0) {
  // One at a time, and never Promise.all. The counter reads either side of a
  // suite are only that suite's if nothing else is touching the database
  // while it runs; run them in parallel and rule 7 becomes the whole-run
  // number this round removed.
  // eslint-disable-next-line no-await-in-loop
  for (const suite of named) results.push(await runSuite(suite));

  for (const { suite, run, report } of results) {
    if (report !== undefined) continue;
    failures.push(
      'a suite produced no readable result, so nothing can be said about\n' +
        `        what ran in it:\n          ${suite}\n        Its output follows.\n\n` +
        `${(run.stdout ?? '') + (run.stderr ?? '')}`.split('\n').slice(0, 20).join('\n'),
    );
  }

  for (const { suite, readError } of results) {
    if (readError === undefined) continue;
    failures.push(
      'could not read the database counter either side of a suite, so rule 7\n' +
        `        cannot say whether it reached the database:\n          ${suite}\n` +
        `        ${firstLine(readError instanceof Error ? readError.message : readError)}`,
    );
  }

  const reports = results.map((r) => r.report).filter((r) => r !== undefined);

  for (const report of reports) {
    ran = {
      total: ran.total + Number(report.numTotalTests ?? 0),
      passed: ran.passed + Number(report.numPassedTests ?? 0),
      failed: ran.failed + Number(report.numFailedTests ?? 0),
      skipped: ran.skipped + Number(report.numPendingTests ?? 0),
      todo: ran.todo + Number(report.numTodoTests ?? 0),
    };
  }

  // 5. A skip is the failure this item is named after.
  const skippedNames = reports
    .flatMap((report) => report.testResults ?? [])
    .flatMap((file) => file.assertionResults ?? [])
    // vitest reports a skip as `skipped`, and the summary counts it under
    // numPendingTests. Reading only `pending` here counted the skip but
    // could not name it, which is half a failure message.
    .filter((t) => t.status === 'skipped' || t.status === 'pending' || t.status === 'todo')
    .map((t) => String(t.fullName ?? t.title ?? 'unnamed test'));

  if (ran.skipped + ran.todo > 0) {
    failures.push(
      `${String(ran.skipped + ran.todo)} database test(s) were skipped:\n` +
        skippedNames.map((n) => `          ${n}`).join('\n') +
        '\n        A skipped database test is the failure this check is named\n' +
        '        after. It looks identical to a passing one in every summary\n' +
        '        that counts only failures.',
    );
  }

  // 4. Zero tests is not a pass.
  if (reports.length > 0 && ran.total === 0) {
    failures.push(
      'zero tests executed.\n' +
        '        The suites were found and ran, and nothing in them was a test.\n' +
        '        Silence is failure here: a green run must mean the named\n' +
        '        suites executed against a database.',
    );
  }

  // 6. Ordinary failures.
  if (ran.failed > 0) {
    failures.push(`${String(ran.failed)} database test(s) failed. Their output is above.`);
  }

  // 8. Bind each named suite to its entry in its own report. Counting tests in
  // aggregate cannot tell which file they came from, so a named suite vitest
  // never discovered is invisible: its siblings supply the total, and the run
  // reports green over a suite that was never loaded.
  const unbound = [];
  for (const { suite, report } of results) {
    const reported = new Map();
    for (const file of report?.testResults ?? []) {
      reported.set(resolve(repoRoot, String(file.name ?? '')), file);
    }
    const file = reported.get(resolve(repoRoot, suite));
    // Only this file, or the counter and the counts were shared with another.
    const others = [...reported.keys()].filter((path) => path !== resolve(repoRoot, suite));
    if (others.length > 0) {
      unbound.push(
        `${suite}\n            vitest ran other files in the same run, so its ` +
          `counts are not its own:\n` +
          others.map((path) => `              ${relative(repoRoot, path)}`).join('\n'),
      );
      continue;
    }
    if (file === undefined) {
      unbound.push(`${suite}\n            vitest never reported this file, so it did not run.`);
      continue;
    }
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    if (assertions.length === 0) {
      unbound.push(`${suite}\n            vitest reported this file with no test in it.`);
      continue;
    }
    const notRun = assertions.filter(
      (t) => t.status === 'skipped' || t.status === 'pending' || t.status === 'todo',
    );
    if (notRun.length > 0) {
      unbound.push(
        `${suite}\n            ${String(notRun.length)} of its ${String(assertions.length)} ` +
          'test(s) did not run.',
      );
    }
  }

  if (unbound.length > 0) {
    failures.push(
      `${String(unbound.length)} named suite(s) cannot be bound to a result:\n` +
        unbound.map((u) => `          ${u}`).join('\n') +
        '\n        Every suite the manifest names must appear in the report with\n' +
        '        tests of its own that ran. A path that exists on disk but sits\n' +
        "        outside vitest's discovery is never loaded, and the totals are\n" +
        '        made up by the suites that were. Aggregates alone never satisfy\n' +
        '        this check.',
    );
  }

  // 9. What vitest itself said, which the counts do not carry. An unhandled
  // rejection is the plain case: vitest fails the run and exits non-zero while
  // every test it counted passed, so numFailedTests is 0 and rule 6 sees
  // nothing. Read the process result and the report's own status instead.
  const reportedErrors = [];
  for (const { suite, run, report } of results) {
    const where = (message) => `${suite}: ${message}`;
    if (run.error !== undefined && run.error !== null) {
      reportedErrors.push(where(`vitest could not be started: ${String(run.error)}`));
    }
    if (typeof run.signal === 'string') {
      reportedErrors.push(where(`vitest was killed by signal ${run.signal}`));
    } else if (run.status !== 0) {
      reportedErrors.push(where(`vitest exited with status ${String(run.status)}`));
    }
    if (report === undefined) continue;
    if (report.success === false) {
      reportedErrors.push(where('the report says the run did not succeed (success: false)'));
    }
    for (const error of Array.isArray(report.errors) ? report.errors : []) {
      reportedErrors.push(
        where(`the report carries an error: ${firstLine(error?.message ?? error)}`),
      );
    }
    for (const file of report.testResults ?? []) {
      const message = String(file.message ?? '').trim();
      if (message !== '') {
        reportedErrors.push(`${String(file.name ?? 'unnamed file')}: ${firstLine(message)}`);
      }
    }
  }

  if (reportedErrors.length > 0) {
    failures.push(
      'vitest reported the run as failed, whatever the test counts say:\n' +
        reportedErrors.map((e) => `          ${e}`).join('\n') +
        '\n        A run that ends in error is not a pass, and an error vitest\n' +
        '        raises outside a test -- an unhandled rejection is the plain\n' +
        '        case -- leaves every counted test passing. The process status\n' +
        '        and the report are the only places it shows.',
    );
  }
}

await client.end().catch(() => {});

// 7. Did each named suite actually reach the database? The counter is read
// either side of each suite's own run, so a suite that passes beside the
// database is named here even when a sibling moved the number.
const beside = results.filter((r) => r.moved <= selfCost);
if (failures.length === 0 && beside.length > 0) {
  failures.push(
    `${String(beside.length)} named suite(s) passed without the database ` +
      'recording a single transaction:\n' +
      beside
        .map(
          (r) =>
            `          ${r.suite}\n            pg_stat_database moved by ` +
            `${String(r.moved)} while it ran.`,
        )
        .join('\n') +
      `\n        A read of the counter costs ${String(selfCost)} on this database, so\n` +
      '        nothing in these suites reached it. A suite that passes beside the\n' +
      "        database is not a conformance proof, and a sibling's transactions\n" +
      '        are not its own.',
  );
}

for (const { suite, moved, readError } of results) {
  console.log(
    readError === undefined
      ? `db-conformance: ${suite} moved the database counter by ${String(moved)}.`
      : `db-conformance: ${suite} was not measured: a counter read failed.`,
  );
}

console.log(
  `db-conformance: ${String(named.length)} named suite(s), ${String(ran.total)} test(s): ` +
    `${String(ran.passed)} passed, ${String(ran.failed)} failed, ${String(ran.skipped + ran.todo)} skipped`,
);
console.log(
  `db-conformance: the database recorded ${String(results.reduce((n, r) => n + r.moved, 0))} ` +
    'transaction(s) across the named suites.',
);

if (failures.length > 0) {
  console.error(`\ndb-conformance: ${String(failures.length)} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    'db-conformance: a green here means the named suites ran against a real\n' +
      'db-conformance: database and none of them skipped. It means nothing else,\n' +
      'db-conformance: and it must never mean less.',
  );
  process.exit(1);
}

console.log('db-conformance: the named suites ran against the database, and none of them skipped.');
