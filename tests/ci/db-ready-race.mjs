// SPDX-License-Identifier: AGPL-3.0-only
// The readiness race behind one `pnpm check` failure at 9da823a, reproduced.
//
// withDatabase in db-conformance-cases.mjs starts the pinned Postgres image on
// a fresh anonymous volume and polls a readiness check before handing the
// runner a TCP URL. The image's entrypoint initialises the cluster with a
// temporary server that listens on the Unix socket only
// (docker-entrypoint.sh: `-c listen_addresses=''`), stops it, then starts the
// real server. A check that goes over the socket can therefore say "ready"
// while nothing listens on TCP yet, and the first TCP connection meets a
// refused or reset socket. That is the ECONNRESET the runner reported.
//
// This script runs that sequence N times with a chosen check and counts how
// often the first TCP connection after "ready" fails. It is a diagnostic, not
// a gate: nothing runs it automatically, and it needs Docker.
//
//   node tests/ci/db-ready-race.mjs --check socket --runs 30   # the old check
//   node tests/ci/db-ready-race.mjs --check tcp --runs 30      # the fixed check
//
// --interval sets the poll interval in milliseconds (default 1000, the same
// as withDatabase). A shorter interval polls through more of the init phase,
// so it finds the window more often; it does not change what the window is.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';

const IMAGE = 'postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

const { values } = parseArgs({
  options: {
    check: { type: 'string', default: 'socket' },
    runs: { type: 'string', default: '30' },
    interval: { type: 'string', default: '1000' },
  },
});

const CHECKS = {
  // The check withDatabase used at 9da823a: over the Unix socket.
  socket: ['pg_isready', '-U', 'postgres', '-d', 'conformance'],
  // The fixed check: over TCP inside the container, which the temporary
  // init server never answers.
  tcp: ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'conformance'],
};

const check = CHECKS[values.check];
if (check === undefined) {
  console.error(`db-ready-race: --check must be one of ${Object.keys(CHECKS).join(', ')}`);
  process.exit(2);
}
const runs = Number(values.runs);
const interval = Number(values.interval);
// A run count that starts no container would report "failed=0" having
// proved nothing, so anything but a positive whole number is refused.
if (!Number.isInteger(runs) || runs < 1) {
  console.error('db-ready-race: --runs must be a whole number of at least 1');
  process.exit(2);
}
if (!Number.isInteger(interval) || interval < 0) {
  console.error('db-ready-race: --interval must be a whole number of milliseconds, 0 or more');
  process.exit(2);
}

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function attempt() {
  const password = randomBytes(18).toString('hex');
  const name = `ops-astro-db-ready-fix-race-${randomBytes(6).toString('hex')}`;
  const started = docker(
    'run',
    '--rm',
    '--detach',
    '--name',
    name,
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    'POSTGRES_DB=conformance',
    '--publish',
    '0:5432',
    IMAGE,
  );
  if (started.status !== 0) throw new Error(`could not start Postgres: ${started.stderr}`);
  try {
    const port = docker('port', name, '5432/tcp').stdout.trim().split(':').pop();
    let polls = 0;
    let ready = false;
    for (; polls < 60 && !ready; polls += 1) {
      ready = docker('exec', name, ...check).status === 0;
      // oxlint-disable-next-line no-await-in-loop -- polls are sequential by design
      if (!ready) await pause(interval);
    }
    if (!ready) return { outcome: 'never-ready', polls };
    const client = new pg.Client({
      connectionString: `postgres://postgres:${password}@127.0.0.1:${port}/conformance`,
    });
    try {
      await client.connect();
      await client.query('select 1');
      return { outcome: 'ok', polls };
    } catch (error) {
      return { outcome: error.code ?? String(error), polls };
    } finally {
      await client.end().catch(() => {});
    }
  } finally {
    docker('rm', '--force', name);
  }
}

const tally = {};
for (let run = 1; run <= runs; run += 1) {
  // oxlint-disable-next-line no-await-in-loop -- one container at a time, as withDatabase runs
  const { outcome, polls } = await attempt();
  tally[outcome] = (tally[outcome] ?? 0) + 1;
  console.log(`run ${run}/${runs} check=${values.check} polls=${polls} ${outcome}`);
}
const failed = runs - (tally['ok'] ?? 0);
console.log(
  `db-ready-race: check=${values.check} interval=${interval}ms runs=${runs} failed=${failed} ${JSON.stringify(tally)}`,
);
process.exit(failed === 0 ? 0 : 1);
