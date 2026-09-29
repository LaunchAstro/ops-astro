// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: the journey command. One documented command that runs the slice's
// cases in order against real Postgres of its own and exits non-zero naming
// every case that did not pass (T4-R1).
//
//   pnpm verify:journey [--pg-port N] [--api-port N] [--web-port N]
//                       [--evidence DIR] [--only journey] [--remove]
//
// Before anything starts it refuses an occupied or another stack's port and
// a pinned Postgres image that is not already on this machine: it never pulls
// (spike RN-03). Then it starts that image as a container of its own,
// migrates it at this head, and runs, one line per case:
//
//   1. the journey (`tests/journey/run.ts`, run as a process because scripts
//      may not import tests): the API and web processes it owns, T2b's served
//      identity at the start and the end, the whole journey through the app
//      and again through the command line with the facts compared
//      (`journey_twice_same_facts`), the separation, the live update, one
//      command-line process per declaration, and a full restart read back and
//      replayed byte for byte;
//   2. T3d2's restart legs (`runtime-proofs.sh`, a container of their own);
//   3. the named suites, T1 to T3's cases (`db-conformance.mjs`, which fails a
//      skip and a suite that never reached the database);
//   4. the cases this base cannot run yet, each printed `unrun` with its reason.
//
// Any `fail` or `unrun` line fails the command. The database is left for
// inspection unless `--remove`; the command prints how to remove it. Every
// process it or its run started is stopped by the pid written down, never by
// name.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DOCKER,
  refusalsBeforeStarting,
  run,
  startPostgres,
  stopStarted,
} from './journey-stack.mjs';
import { builtCases, protectedVerdicts } from './journey-proofs.ts';

const ROOT = resolve(import.meta.dirname, '../..');
/**
 * What this base cannot run yet, with the reason. Each prints `unrun` and
 * fails the command until the part lands here (Rebase notes on the pull request).
 */
const UNRUN = [
  [
    'T2g: request changes, the revision round, journey_parity_cli',
    'T2g (#136) is not on this base; the re-baseline brings it',
  ],
  [
    'T3a: escalate at the bound, reject, cancel and restart',
    'T3a (#153) is not on this base; the re-baseline brings it',
  ],
  [
    'T4c: the pinned-mockup comparison at 1480, 900 and 390',
    'T4c (#134) is not on this base; the re-baseline brings it',
  ],
  [
    'the browser pass (slice-acceptance) on this stack',
    'the web app signs in through GoTrue, which this stack does not start yet',
  ],
  [
    'keyboard-only and 390-wide passes over the whole journey (T4-R9)',
    'they drive the browser, which needs GoTrue on this stack, and the revision round needs T2g',
  ],
];

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
const evidence = resolve(flag('--evidence', join(ROOT, '.local', 'journey', stamp)));
const container = `ops-astro-journey-${stamp.toLowerCase()}`;
const password = `journey_${randomUUID().replaceAll('-', '')}`;
const admin = `postgres://postgres:${password}@127.0.0.1:${pg}/journey`;
const pidfile = join(evidence, 'journey.pids');
const lines = [];

function say(line) {
  console.log(`journey: ${line}`);
}

function record(name, status, raw) {
  // The container's password never reaches a line, whatever a failure quotes.
  const detail = raw.replaceAll(password, '<password>');
  lines.push({ case: name, status, detail });
  appendFileSync(
    join(evidence, 'cases.jsonl'),
    `${JSON.stringify({ case: name, status, detail })}\n`,
  );
  say(`${status.padEnd(5)} ${name}${detail === '' ? '' : ` -- ${detail}`}`);
}

/** The journey's own run, one `journey-case` line per case on its stdout. */
async function journey() {
  const child = spawn(process.execPath, ['tests/journey/run.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: admin,
      DATABASE_ADMIN_URL: admin,
      JOURNEY_API_PORT: String(ports.api),
      JOURNEY_WEB_PORT: String(ports.web),
      JOURNEY_PG_CONTAINER: container,
      JOURNEY_PIDFILE: pidfile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appendFileSync(pidfile, `${String(child.pid)} tests/journey/run.ts\n`);
  let seen = 0;
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const complete = buffer.split('\n');
    buffer = complete.pop() ?? '';
    for (const line of complete.filter((one) => one.startsWith('journey-case '))) {
      const one = JSON.parse(line.slice('journey-case '.length));
      seen += 1;
      record(one.case, one.status, one.detail);
    }
  });
  // Whole lines, so the password cannot be split across two writes and pass the scrub.
  let errors = '';
  const scrubbed = (text) => text.replaceAll(password, '<password>');
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString('utf8');
    const cut = errors.lastIndexOf('\n') + 1;
    appendFileSync(join(evidence, 'run.stderr'), scrubbed(errors.slice(0, cut)));
    errors = errors.slice(cut);
  });
  const code = await new Promise((done) => {
    child.once('close', done);
  });
  appendFileSync(join(evidence, 'run.stderr'), scrubbed(errors));
  // Exit 1 is the run's own verdict, already on its case lines; anything else is the run breaking.
  if (seen === 0 || (code !== 0 && code !== 1)) {
    const detail = `exit ${String(code)}, ${String(seen)} cases; stderr in ${join(evidence, 'run.stderr')}`;
    record('the journey run itself', 'fail', detail);
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
  for (const [name, reason] of UNRUN) record(name, 'unrun', reason);
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
  record(
    'stack: Postgres from the pinned digest, migrated at this head',
    stack.ok ? 'pass' : 'fail',
    stack.detail,
  );
  if (stack.ok) await journey();
  afterJourney();
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
