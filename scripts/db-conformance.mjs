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
//   6. no test failed (on a merge group, a suite the timing-failure rule
//      re-ran is judged on its re-run; scripts/timing-rule.ts);
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
// Usage: node scripts/db-conformance.mjs [--manifest <path> | --isolation] [--shard <i>/<n>] [--list]
//   --isolation runs the isolation suites: the named suites whose file says so
//   (scripts/named-suites.ts readIsolationSuites).
//   DATABASE_URL  the database to run against. Required.
//   --shard       run only shard i of n (scripts/db-shards.ts decides which
//                 suites; for --isolation, scripts/ci-shards.ts). Rules 2 and
//                 3 still read the whole manifest.
//   --without-isolation
//                 leave out the isolation suites (scripts/db-shards.ts
//                 databaseItems): ci.yml's `database conformance` shards,
//                 beside the `isolation tests` shards that run them. Any other
//                 caller, the nightly look-ahead's included, runs them.
//   --list        print the run items it would run, one a line, and stop
//                 before reaching the database (tests/ci/ci-shards.test.ts).
//   A suite tests/db/shard-plan.json splits into parts runs once per part,
//   with SUITE_PART=i/k, sharded or not; every rule applies to each part.
//   --timing-rule <plan>
//                 the plan scripts/timing-rule.ts wrote for this run. On a
//                 merge group, a suite the group does not touch that fails
//                 only on its tests runs once more, and a pass is logged as
//                 timing; a quarantined suite the group does not touch is
//                 left out. Without it nothing is re-run or left out; a plan
//                 it cannot read is refused.
//   --quarantined runs only the plan's quarantined suites, for the nightly
//                 run, and passes when there are none.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import pg from 'pg';
import {
  assignShards,
  databaseItems,
  itemOf,
  parseShard,
  planItems,
  readPlan,
} from './db-shards.ts';
import { ISOLATION_STEPS, isolationShards, readShardPlan } from './ci-shards.ts';
import { manifestPathIn, readIsolationSuites, readNamedSuites, suiteList } from './named-suites.ts';
import { ensureMigratedTemplate, templateEnabled } from './migrated-template.ts';
import { readRulePlan, touchedBy } from './timing-rule.ts';
// One verdict line per run item, the only lines the journey's protected
// verdicts read. Kept beside its reader; exported here as the runner's own.
import { verdictLine } from './local/journey-proofs.ts';

export { verdictLine };

const repoRoot = resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const manifestFlag = argv.indexOf('--manifest');
const isolationRun = argv.includes('--isolation');
const withoutIsolation = argv.includes('--without-isolation');
if (isolationRun && withoutIsolation) {
  console.error('db-conformance: --isolation and --without-isolation do not go together.');
  process.exit(2);
}
// Without --manifest the runner reads the repository's own manifest, the
// per-area folder or the single file (scripts/named-suites.ts); with it, that
// one file, as given.
const manifestPath = resolve(
  manifestFlag === -1 ? manifestPathIn(repoRoot) : argv[manifestFlag + 1],
);

const shardFlag = argv.indexOf('--shard');
let shard;
try {
  shard = shardFlag === -1 ? undefined : parseShard(argv[shardFlag + 1]);
} catch (error) {
  console.error(`db-conformance: ${error instanceof Error ? error.message : String(error)}.`);
  process.exit(2);
}

// The timing-failure rule (scripts/timing-rule.ts) reads only the plan its own
// step wrote, never the quarantine file or the API.
const ruleFlag = argv.indexOf('--timing-rule');
const quarantinedRun = argv.includes('--quarantined');
let rule;
try {
  const planPath = ruleFlag === -1 ? undefined : (argv[ruleFlag + 1] ?? '');
  if (planPath !== undefined && !existsSync(planPath)) {
    throw new Error(`timing-rule plan: there is none at ${planPath}`);
  }
  rule = planPath === undefined ? undefined : readRulePlan(readFileSync(planPath, 'utf8'));
} catch (error) {
  console.error(`db-conformance: ${error instanceof Error ? error.message : String(error)}.`);
  process.exit(2);
}
if (quarantinedRun && rule?.event !== 'nightly') {
  console.error('db-conformance: --quarantined needs a nightly plan given with --timing-rule.');
  process.exit(2);
}
const inGroup = rule?.event === 'merge_group';
const quarantine = new Map((rule?.quarantined ?? []).map((entry) => [entry.test, entry]));
/** Whether the group's diff misses the suite; one that cannot be read counts as touched. */
const untouched = (suite) => {
  try {
    return !touchedBy(repoRoot, suite, rule?.changed ?? []);
  } catch {
    return false;
  }
};

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

// A list that is not an array of strings is refused, never read as empty: a
// suite category that silently disappears leaves the others to make a green.
let named;
try {
  let manifest;
  if (manifestFlag === -1) {
    manifest = isolationRun ? readIsolationSuites(repoRoot) : readNamedSuites(repoRoot);
  } else {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  }
  named = ['invariant', 'conformance'].flatMap((kind) =>
    suiteList(manifestPath, kind, manifest?.[kind]),
  );
} catch (error) {
  console.error(`db-conformance: cannot read ${manifestPath}: ${String(error)}`);
  process.exit(2);
}

const failures = [];

// A shard runs its share of the run items; every rule below reads that share,
// except 2 and 3, which read the whole manifest in every shard.
const plan = readPlan(join(repoRoot, 'tests/db/shard-plan.json'));
const items = planItems(named, plan.parts);
/** The items this run splits: all of them, or all but the isolation suites'. */
const runItems = withoutIsolation
  ? databaseItems(items, readIsolationSuites(repoRoot).invariant)
  : items;
/** This shard's items: an isolation shard's from the split beside its steps, which run outside this. */
const shareOf = ({ index, count }) =>
  isolationRun
    ? (isolationShards(items, readShardPlan(repoRoot), count)[index - 1] ?? []).filter(
        (item) => !ISOLATION_STEPS.includes(item),
      )
    : (assignShards(runItems, plan.seconds, count)[index - 1] ?? []);
const shardItems = shard === undefined ? runItems : shareOf(shard);
// The nightly run takes every quarantined suite; a merge group leaves out each
// quarantined suite it does not touch, and runs the rest of its share.
const toRun = quarantinedRun
  ? runItems.filter((item) => quarantine.has(itemOf(item).suite))
  : shardItems.filter(
      (item) => !(inGroup && quarantine.has(itemOf(item).suite) && untouched(itemOf(item).suite)),
    );
const leftOut = shardItems.filter((item) => !quarantinedRun && !toRun.includes(item));
// Prints this shard's suites for tests/ci/ci-shards.test.ts. It runs none, so
// it never exits 0: a stray --list in a CI command fails that shard. It exits
// once the list has left: a write to a full pipe is queued, and an exit
// before it drains loses the tail.
if (argv.includes('--list')) {
  process.stdout.write(toRun.map((item) => `${item}\n`).join(''), () => process.exit(3));
  await new Promise(() => {});
}
const shardLabel =
  shard === undefined ? '' : `shard ${String(shard.index)}/${String(shard.count)} `;

if (quarantinedRun && toRun.length === 0) {
  console.log('db-conformance: no suite is quarantined, so the nightly run has nothing to run.');
  process.exit(0);
}

/** A line for the job's summary, when the job has one. */
const summarise = (line) => {
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary) appendFileSync(summary, `${line}\n`);
};

for (const item of leftOut) {
  const { ticket, owner, expires } = quarantine.get(itemOf(item).suite);
  const why = `quarantined, #${String(ticket)}, owner ${owner}, until ${expires}`;
  console.log(
    `db-conformance: ${item} is left out of this merge group: ${why} (.github/test-quarantine.json).`,
  );
  summarise(`- ${item}: ${why}; it runs nightly.`);
}

// A shard whose whole share is quarantined and left out has nothing to run,
// and that is the rule working: its suites run nightly (S1862-2).
if (named.length > 0 && toRun.length === 0 && leftOut.length === 0) {
  failures.push(
    `${shardLabel}was given no suite. A shard that runs nothing proves nothing;\n` +
      '        use fewer shards than the manifest has suites.',
  );
}

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

if (failures.length === 0 && toRun.length === 0 && leftOut.length > 0) {
  console.log(
    `db-conformance: ${shardLabel}left out all ${String(leftOut.length)} of its suite(s) as quarantined; they run nightly.`,
  );
  process.exit(0);
}

/** The first line of a message, for a failure list that stays readable. */
const firstLine = (value) =>
  String(value ?? '')
    .split('\n')[0]
    .trim();

/** The database's transaction and normal client-session counts. */
const readCounter = async (client) => {
  // Flush this backend's pending reads so calibration and suite reads cost the same.
  await client.query('select pg_stat_force_next_flush()');
  const { rows } = await client.query(
    'select xact_commit + xact_rollback as n, sessions from pg_stat_database where datname = current_database()',
  );
  return { transactions: Number(rows[0]?.n ?? 0), sessions: Number(rows[0]?.sessions ?? 0) };
};

const client = new pg.Client({ connectionString: url });
let selfCost = 0;

try {
  // The migrated template is no suite's work, and building it takes a lock in
  // `postgres`, which may be the database measured here. So it is built now,
  // before the first read, and each suite's global setup only finds it
  // finished, beside the measured database (scripts/migrated-template.ts). A run
  // that has already failed builds nothing. It comes before the connection: a
  // session flushes its counts at most once a second, so one left idle through
  // the build makes the first read flush and the measured read cost twice that.
  if (failures.length === 0 && templateEnabled()) {
    await ensureMigratedTemplate(process.env['DATABASE_ADMIN_URL'] ?? url);
  }
  await client.connect();
  // Two consecutive reads measure what a read of the counter costs, so the
  // threshold below is calibrated on this database rather than assumed. The
  // same pair of reads brackets each suite, so the cost is the same one.
  const first = await readCounter(client);
  const second = await readCounter(client);
  selfCost = Math.max(1, second.transactions - first.transactions);
} catch (error) {
  console.error(
    'db-conformance: the database named by DATABASE_URL did not answer, or its migrated template was not built.',
  );
  console.error(`db-conformance: ${String(error)}`);
  await client.end().catch(() => {});
  process.exit(1);
}

let ran = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };

const vitestBin = join(repoRoot, 'node_modules/vitest/vitest.mjs');
let failureDetailRemaining = 16 * 1024;
const diagnosticSecrets = Object.entries(process.env)
  .filter(([key, value]) => /PASSWORD|TOKEN|SECRET|KEY/iu.test(key) && value)
  .map(([, value]) => value);
for (const connectionString of [url, process.env['DATABASE_ADMIN_URL']]) {
  if (!connectionString) continue;
  try {
    const password = new URL(connectionString).password;
    if (password) diagnosticSecrets.push(password, decodeURIComponent(password));
  } catch {
    // Connection validation stays with the database client.
  }
}

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

/** Redact a failed assertion, or any problem the run reports, before it reaches stderr. */
const redactDetail = (detail) => {
  detail = stripVTControlCharacters(detail)
    .replaceAll(`file://${repoRoot}/`, '')
    .replaceAll(`${repoRoot}/`, '');
  for (const secret of diagnosticSecrets) detail = detail.replaceAll(secret, '[redacted]');
  detail = detail
    .replaceAll(/([a-z][a-z\d+.-]*:\/\/)[^\s/]+@/giu, '$1[redacted]@')
    .replaceAll(
      /(Bearer\s+|(?:password|token|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]+/giu,
      '$1[redacted]',
    )
    .replaceAll(
      /(?<![\w./])(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)[^\s"'<>()[\],]+/gu,
      '[private path]',
    );
  return detail;
};

/** Print failed assertions within the per-assertion and whole-run detail limits. */
const printFailedAssertions = (report, suite, part) => {
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== 'failed' || failureDetailRemaining === 0) continue;
      let detail =
        `db-conformance: failed assertion in ${suite}${part ? ` [${part}]` : ''}\n` +
        `  ${String(assertion.fullName ?? assertion.title ?? 'unnamed test')}\n` +
        (assertion.failureMessages ?? []).map(String).join('\n');
      detail = redactDetail(detail);
      const bounded = detail.slice(0, Math.min(4000, failureDetailRemaining));
      console.error(bounded);
      failureDetailRemaining -= bounded.length;
      if (bounded.length < detail.length)
        console.error('db-conformance: assertion detail truncated.');
    }
  }
};

/** Read and diagnose the report before removing its temporary directory. */
const readReport = (reportPath, suite, part) => {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
    printFailedAssertions(report, suite, part);
  } catch {
    report = undefined;
  } finally {
    rmSync(join(reportPath, '..'), { recursive: true, force: true });
  }
  return report;
};

/**
 * vitest over one suite alone: its JSON report to `reportPath`, and the count
 * of errors raised outside any test to `unhandledPath`.
 */
const vitestRun = (suite, part, reportPath, unhandledPath) =>
  spawnSync(
    process.execPath,
    [
      vitestBin,
      'run',
      '--reporter=json',
      `--reporter=${join(repoRoot, 'scripts/vitest-unhandled-errors.mjs')}`,
      `--outputFile=${reportPath}`,
      ...siblingsOf(suite).map((path) => `--exclude=${path}`),
      suite,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: url,
        CI: 'true',
        SUITE_PART: part ?? '',
        UNHANDLED_ERRORS_FILE: unhandledPath,
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );

/**
 * One vitest run over one named suite, with the database's counter read
 * either side of it. Running the suites together made rule 7 a whole-run
 * number that no suite owned; running them one at a time is what gives each
 * path a transaction count of its own.
 */
const runSuite = async (suite, part) => {
  // vitest's JSON reporter writes to a file, never to stdout, so the report
  // is collected from one and removed afterwards.
  const reportPath = join(mkdtempSync(join(tmpdir(), 'hub-db-conformance-')), 'report.json');
  const unhandledPath = join(reportPath, '..', 'unhandled-errors');
  // A read that fails is not a measurement. Copilot on PR A: substituting
  // zero for a failed pre-suite read turned the cumulative counter into a
  // movement, and a suite that never touched the database passed rule 7.
  // Either read failing leaves the suite unmeasured, and that fails the run.
  let before = { transactions: 0, sessions: 0 };
  let readError;
  try {
    before = await readCounter(client);
  } catch (error) {
    readError = error;
  }
  const run = vitestRun(suite, part, reportPath, unhandledPath);
  let after = before;
  if (readError === undefined) {
    try {
      after = await readCounter(client);
    } catch (error) {
      readError = error;
    }
  }
  // Read before readReport removes the folder; absent is unknown, never zero.
  const unhandled = existsSync(unhandledPath)
    ? Number(readFileSync(unhandledPath, 'utf8'))
    : undefined;
  const report = readReport(reportPath, suite, part);
  return {
    suite,
    run,
    report,
    moved: after.transactions - before.transactions,
    clientSessions: after.sessions - before.sessions,
    readError,
    unhandled,
  };
};

const results = [];

/**
 * A failure its tests alone own: vitest exited 1 on a readable report of this
 * suite only, with failed tests and nothing skipped, raised outside a test
 * (its JSON report or, for unhandled errors, scripts/vitest-unhandled-errors.mjs)
 * or unmeasured. Only this is re-run; any other failure is not timing.
 */
const failedOnItsTests = ({ suite, run, report, readError, unhandled }) => {
  const files = Array.isArray(report?.testResults) ? report.testResults : [];
  return (
    readError === undefined &&
    unhandled === 0 &&
    (run.error ?? undefined) === undefined &&
    run.signal === null &&
    run.status === 1 &&
    Number(report?.numFailedTests ?? 0) > 0 &&
    Number(report?.numPendingTests ?? 0) + Number(report?.numTodoTests ?? 0) === 0 &&
    (Array.isArray(report?.errors) ? report.errors.length : 0) === 0 &&
    files.length === 1 &&
    resolve(repoRoot, String(files[0]?.name ?? '')) === resolve(repoRoot, suite) &&
    String(files[0]?.message ?? '').trim() === ''
  );
};
const passed = ({ run, report, readError }) =>
  readError === undefined &&
  run.signal === null &&
  run.status === 0 &&
  report?.success !== false &&
  Number(report?.numFailedTests ?? 1) === 0;
const failedNames = (report) =>
  (report?.testResults ?? [])
    .flatMap((file) => file.assertionResults ?? [])
    .filter((test) => test.status === 'failed')
    .map((test) => String(test.fullName ?? test.title ?? 'unnamed test'));
const timing = [];

if (failures.length === 0) {
  // One at a time, and never Promise.all. The counter reads either side of a
  // suite are only that suite's if nothing else is touching the database
  // while it runs; run them in parallel and rule 7 becomes the whole-run
  // number this round removed.
  for (const item of toRun) {
    const { suite, part } = itemOf(item);
    const started = performance.now();
    // eslint-disable-next-line no-await-in-loop
    let result = await runSuite(suite, part);
    // The timing-failure rule: one re-run, on a merge group, of a suite the
    // group does not touch that failed only on its tests. Every rule below
    // judges the re-run's result.
    if (inGroup && failedOnItsTests(result) && untouched(suite)) {
      const failed = failedNames(result.report);
      console.log(
        `db-conformance: ${item} failed in a suite this group does not touch; running it once more (the timing-failure rule).`,
      );
      // eslint-disable-next-line no-await-in-loop
      result = await runSuite(suite, part);
      if (passed(result)) timing.push({ item, failed });
      else console.error(`db-conformance: ${item} failed again on its one re-run, so it blocks.`);
    }
    results.push({ ...result, item, seconds: (performance.now() - started) / 1000 });
  }

  // Each pass on a re-run is logged as timing, with what a quarantine entry needs.
  for (const { item, failed } of timing) {
    const line = redactDetail(
      `timing: ${item} (${failed.join('; ')}) failed, then passed on its one re-run; ` +
        `run ${rule.run}; pull requests ${rule.pulls.map((n) => `#${n}`).join(', ')}`,
    ).replaceAll(/\s+/gu, ' ');
    console.log(`::warning title=timing::${line.replaceAll('%', '%25')}`);
    summarise(`- ${line}`);
  }

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
    failures.push(`${String(ran.failed)} database test(s) failed. See the assertion detail above.`);
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
// Each suite starts a fresh process. Reader and autovacuum transactions are not its SQL.
const beside = results.filter((r) => r.moved <= selfCost || r.clientSessions <= 0);
if (failures.length === 0 && beside.length > 0) {
  failures.push(
    `${String(beside.length)} named suite(s) did not show both ` +
      'transaction movement above measurement cost and a new client session:\n' +
      beside
        .map(
          (r) =>
            `          ${r.item}\n            pg_stat_database moved by ` +
            `${String(r.moved)} while it ran, with ${String(r.clientSessions)} new client session(s).`,
        )
        .join('\n') +
      `\n        A read of the counter costs ${String(selfCost)} on this database.\n` +
      '        Each suite must also establish a client session. A suite that passes beside the\n' +
      "        database is not a conformance proof, and a sibling's transactions\n" +
      '        are not its own.',
  );
}

for (const { item, moved, readError, seconds } of results) {
  const took = seconds.toFixed(1);
  console.log(
    readError === undefined
      ? `db-conformance: ${item} moved the database counter by ${String(moved)} in ${took}s.`
      : `db-conformance: ${item} was not measured: a counter read failed.`,
  );
}
for (const result of results) console.log(verdictLine(result.item, { ...result, cost: selfCost }));

const ofNamed =
  shard === undefined ? '' : `ran ${String(toRun.length)} of ${String(items.length)} item(s) from `;
console.log(
  `db-conformance: ${shardLabel}${ofNamed}${String(named.length)} named suite(s), ` +
    `${String(ran.total)} test(s): ` +
    `${String(ran.passed)} passed, ${String(ran.failed)} failed, ${String(ran.skipped + ran.todo)} skipped`,
);
console.log(
  `db-conformance: the database recorded ${String(results.reduce((n, r) => n + r.moved, 0))} ` +
    'transaction(s) across the named suites.',
);

if (failures.length > 0) {
  console.error(`\ndb-conformance: ${String(failures.length)} problem(s)\n`);
  // Every problem passes through the same redaction as a failed assertion, so
  // a suite's error, its output, a skipped test's name or a database message
  // carries no credential or private path into the log.
  for (const f of failures) console.error(`  ${redactDetail(f)}\n`);
  console.error(
    'db-conformance: a green here means the named suites ran against a real\n' +
      'db-conformance: database and none of them skipped. It means nothing else,\n' +
      'db-conformance: and it must never mean less.',
  );
  process.exit(1);
}

console.log('db-conformance: the named suites ran against the database, and none of them skipped.');
