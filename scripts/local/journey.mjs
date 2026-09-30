// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: the journey command. One documented command that runs the slice's
// cases in order against real Postgres of its own and exits non-zero naming
// every case that did not pass (T4-R1).
//
//   pnpm verify:journey [--pg-port N] [--api-port N] [--web-port N]
//                       [--evidence DIR] [--only journey] [--remove]
//   pnpm verify:journey --self-test [--pg-port N] [--remove]
//
// It refuses another stack's port, a port in use and a pinned Postgres image
// not already on this machine before starting anything (it never pulls,
// RN-03), starts that image as its own container, migrates it, and prints one
// line per case: the journey (`tests/journey/run.ts`, a process, since scripts
// may not import tests) twice with its facts compared, its separation, live
// update, CLI declarations, restart and replay; T3d2's restart legs; the named
// suites with one verdict per protected component; the built bundle's scan;
// the worker's structure; and `unrun` with its reason for what this base
// cannot run. Any line that is not `pass` fails the command. It then prints
// the budgets and writes the evidence bundle (T4d). The database is kept
// unless `--remove`. What the run started is stopped by the process groups it
// created, each checked for a journey command first: never by name, never by
// a plain pid, which may be another process's by then.
// `--self-test` (T4e) runs instead the mutations showing each check fails on
// what it claims, and fails naming any that stayed green.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { commandBudgets, revision, writeBundle } from './journey-bundle.ts';
import {
  DOCKER,
  IMAGE,
  refusalsBeforeStarting,
  run,
  startPostgres,
  stopStarted,
} from './journey-stack.ts';
import { builtCases, protectedVerdicts } from './journey-proofs.ts';
import { emptyMeasures, takeMeasure } from './journey-measure.ts';
import { runTestSide } from './journey-process.ts';

const ROOT = resolve(import.meta.dirname, '../..');
/**
 * What this base cannot run yet, with the reason. Each prints `unrun` and
 * fails the command until the part lands here (Rebase notes on the pull request).
 */
const UNRUN = [
  ['T2g: request changes, the revision round, journey_parity_cli', { owner: 'T2g', pr: '#136' }],
  ['T3a: escalate at the bound, reject, cancel and restart', { owner: 'T3a', pr: '#153' }],
  ['T4c: the pinned-mockup comparison at 1480, 900 and 390', { owner: 'T4c', pr: '#134' }],
].map(([name, facts]) => [
  name,
  `${facts.owner} (${facts.pr}) is not on this base; the re-baseline brings it`,
  facts,
]);
UNRUN.push(
  [
    'the browser pass (slice-acceptance) on this stack',
    'the web app signs in through GoTrue, which this stack does not start yet',
    { owner: 'T4b1' },
  ],
  [
    'keyboard-only and 390-wide passes over the whole journey (T4-R9)',
    'they drive the browser, which needs GoTrue on this stack, and the revision round needs T2g',
    { owner: 'T4b2' },
  ],
);

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
const pg = flag('--pg-port', '54430');
const apiPort = flag('--api-port', '8830');
// The restart legs take the next port up from each; a malformed base stays malformed.
const next = (port) => (/^\d+$/u.test(port) ? String(Number(port) + 1) : port);
const ports = {
  pg,
  api: apiPort,
  web: flag('--web-port', '5230'),
  proofsPg: next(pg),
  proofsApi: next(apiPort),
};
const onlyJourney = flag('--only', '') === 'journey';
const selfTesting = args.includes('--self-test');
const evidence = resolve(flag('--evidence', join(ROOT, '.local', 'journey', stamp)));
const container = `ops-astro-journey-${stamp.toLowerCase()}`;
const password = `journey_${randomUUID().replaceAll('-', '')}`;
const admin = `postgres://postgres:${password}@127.0.0.1:${pg}/journey`;
const pidfile = join(evidence, 'journey.pids');
const lines = [];
/** What the run hands the bundle beside its case lines (T4d). */
const carried = { approval: undefined, budgets: [], measures: emptyMeasures() };
const begun = performance.now();
const loadAtStart = os.loadavg()[0];

function say(line) {
  console.log(`journey: ${line}`);
}

/** One case line; `facts` is what the command's code typed beside it, the bundle's only view. */
function record(name, status, raw, facts) {
  // The container's password never reaches a line, whatever a failure quotes.
  const detail = raw.replaceAll(password, '<password>');
  const line = { case: name, status, detail, ...(facts === undefined ? {} : { facts }) };
  lines.push(line);
  appendFileSync(join(evidence, 'cases.jsonl'), `${JSON.stringify(line)}\n`);
  say(`${status.padEnd(5)} ${name}${detail === '' ? '' : ` -- ${detail}`}`);
}

/** One line of the run's output: a case, or what it hands the bundle (T4d). */
function take(line) {
  const [kind] = line.split(' ', 1);
  const value = line.slice(`${kind} `.length);
  if (kind === 'journey-case') {
    const one = JSON.parse(value);
    record(one.case, one.status, one.detail, one.facts);
  } else if (kind === 'journey-approval') carried.approval = JSON.parse(value);
  else if (kind === 'journey-budget') carried.budgets.push(JSON.parse(value));
  else if (kind === 'journey-measure') takeMeasure(carried.measures, value);
}

/** A test-side run (`journey-process.ts`); its case lines come back with its exit code. */
async function runLines(file, own, stderr) {
  const before = lines.length;
  const env = { DATABASE_URL: admin, DATABASE_ADMIN_URL: admin, ...own };
  const side = { root: ROOT, file, env, pidfile, stderr: join(evidence, stderr), password, take };
  return { code: await runTestSide(side), ran: lines.slice(before) };
}

/** The journey's own run (`tests/journey/run.ts`). */
async function journey() {
  const { code, ran } = await runLines(
    'tests/journey/run.ts',
    {
      JOURNEY_API_PORT: String(ports.api),
      JOURNEY_WEB_PORT: String(ports.web),
      JOURNEY_PG_CONTAINER: container,
      JOURNEY_PIDFILE: pidfile,
    },
    'run.stderr',
  );
  // Exit 1 is the run's own verdict, already on its case lines; anything else is the run breaking.
  const seen = ran.length;
  // Reached its end: the closing identity line is there and nothing broke on the way.
  const ended = ran.some((line) => line.case === 'identity at the end (T2b)');
  carried.measures.journeyRan = ended && !ran.some((line) => line.case === 'run');
  if (seen === 0 || (code !== 0 && code !== 1)) {
    const detail = `exit ${String(code)}, ${String(seen)} cases; stderr in ${join(evidence, 'run.stderr')}`;
    record('the journey run itself', 'fail', detail);
  }
}

/** T4e, `--self-test`: the mutations on this command's own Postgres, ending `every_invariant_bites`. */
async function selfTest() {
  const proofs = {
    SELF_TEST_PROOFS_PORT: ports.proofsPg,
    SELF_TEST_PROOFS_API_PORT: ports.proofsApi,
  };
  const own = { SELF_TEST_CLUSTER: container, DOCKER, ...proofs };
  const { code, ran } = await runLines('tests/ci/self-test/run.ts', own, 'self-test.stderr');
  if (!ran.some((line) => line.case === 'every_invariant_bites') || (code !== 0 && code !== 1)) {
    const detail = `exit ${String(code)}, ${String(ran.length)} cases; stderr in ${join(evidence, 'self-test.stderr')}`;
    record('the self-test run itself', 'fail', detail);
  }
}

/**
 * T3d2's restart legs, T1 to T3's named suites with the protected set's
 * verdicts read from that same run, the built bundle and the worker's
 * structure, then what this base cannot run.
 */
function afterJourney() {
  const proofs = 'T3d2 restart legs (runtime-proofs)';
  const suites = 'named suites: T1 to T3 cases and the conformance proofs (db:conformance)';
  if (onlyJourney) {
    for (const name of [proofs, suites, 'the protected set, the bundle and the worker structure']) {
      record(name, 'unrun', 'skipped by --only journey');
    }
  } else {
    const file = join(evidence, 'runtime-proofs.txt');
    const own = ['--name', `${container}-proofs`, '--port', ports.proofsPg];
    const api = ['--api-port', ports.proofsApi, '--evidence', file];
    const legs = run('bash', ['scripts/local/runtime-proofs.sh', ...own, ...api]);
    record(proofs, legs.ok ? 'pass' : 'fail', `evidence ${file}`);
    const env = { DATABASE_URL: admin, DATABASE_ADMIN_URL: admin };
    const named = run(process.execPath, ['scripts/db-conformance.mjs'], env);
    appendFileSync(
      join(evidence, 'db-conformance.txt'),
      named.out.replaceAll(password, '<password>'),
    );
    const tail = named.out.trim().split('\n').slice(-3).join(' / ');
    record(suites, named.ok ? 'pass' : 'fail', tail);
    const manifest = JSON.parse(readFileSync(join(ROOT, 'tests/db/named-suites.json'), 'utf8'));
    for (const line of [...protectedVerdicts(named.out, manifest), ...builtCases()]) {
      record(line.case, line.status, line.detail);
    }
  }
  for (const [name, reason, facts] of UNRUN) record(name, 'unrun', reason, facts);
}

/** T4d: the budgets the command measures itself, then the bundle beside the case lines. */
function bundle() {
  const { migrateMs, seedMs, journeyRan } = carried.measures;
  const elapsed = performance.now() - begun;
  const own = commandBudgets(migrateMs, elapsed, seedMs, loadAtStart, journeyRan === true);
  const budgets = [...carried.budgets, ...own];
  for (const { status, operation, measured, budget, load } of budgets) {
    say(`budget ${status.padEnd(8)} ${operation}: ${measured} against ${budget} (${load})`);
  }
  const proofs = join(evidence, 'runtime-proofs.txt');
  const name = 'evidence bundle written (bundle_names_the_approval)';
  const end = lines.find((line) => line.case === 'identity at the end (T2b)');
  const system = `${os.type()} ${os.release()} ${os.arch()}`;
  try {
    const written = writeBundle({
      ...revision(),
      identity: end?.detail ?? 'not recorded',
      environment: {
        node: process.version,
        os: system,
        image: IMAGE,
        ports: JSON.stringify(ports),
      },
      cases: lines,
      budgets,
      crashPoints: existsSync(proofs) ? readFileSync(proofs, 'utf8') : '',
      approval: carried.approval,
    });
    for (const [file, text] of [
      ['bundle.json', written.json],
      ['bundle.md', written.markdown],
    ]) {
      writeFileSync(join(evidence, file), text.replaceAll(password, '<password>'));
    }
    record(name, 'pass', join(evidence, 'bundle.md'));
  } catch (error) {
    record(name, 'fail', String(error));
  }
}

mkdirSync(evidence, { recursive: true });
const refusals = await refusalsBeforeStarting(ports, container);
for (const refusal of refusals) say(`refused: ${refusal}`);
if (refusals.length > 0) process.exit(2);
let removed = false;
const finish = () => {
  stopStarted(pidfile, say);
  if (args.includes('--remove') && !removed) {
    removed = true;
    run(DOCKER, ['rm', '-f', '-v', container]);
    say(`removed ${container}`);
  }
};
process.once('SIGINT', () => {
  finish();
  process.exit(130);
});
process.once('SIGTERM', () => {
  finish();
  process.exit(143);
});
try {
  const stack = await startPostgres({ container, password, port: pg, admin });
  carried.measures.migrateMs = stack.migrateMs;
  record(
    'stack: Postgres from the pinned digest, migrated at this head',
    stack.ok ? 'pass' : 'fail',
    stack.detail,
  );
  if (selfTesting) {
    if (stack.ok) await selfTest();
  } else {
    if (stack.ok) await journey();
    afterJourney();
    bundle();
  }
} finally {
  finish();
}
const short = lines.filter((line) => line.status !== 'pass');
say(
  `${String(lines.length - short.length)} passed, ${String(short.length)} not passed; evidence in ${evidence}`,
);
for (const line of short) say(`not passed: ${line.case}`);
if (!args.includes('--remove')) {
  say(
    `the database is kept in ${container} on 127.0.0.1:${pg}; remove it with ${DOCKER} rm -f -v ${container}`,
  );
}
process.exitCode = short.length === 0 ? 0 : 1;
