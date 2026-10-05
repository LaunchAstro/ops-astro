// SPDX-License-Identifier: AGPL-3.0-only
//
// One throwaway container of staging's pinned Postgres image, attached, for
// the backup's dump and every reach of the store (#489, OW-062.2, OW-062.3).
// Its lifetime is the container's, never only the `docker run` client's: a
// client killed or stopped leaves its container running, and psql or pg_dump
// as PID 1 ignores the SIGTERM docker passes on. So each run writes its
// container's id to a file of its own (`--cidfile`, which docker writes only
// once it has made that container), and stopping removes the container by
// that id. A name is never used to stop anything, so a run never removes
// another's container. A run that ends by a signal, or with any code but 0,
// has failed, and its container is removed too.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
);

// How long a stop waits for docker to remove the container.
const STOP_MS = 20_000;
// How long a stopped client has to end before it is killed.
const GRACE_MS = 2000;

/**
 * `docker run` arguments for `command` in staging's pinned Postgres image on
 * `network`, named for `role`, the environment names in `names` passed by
 * name only, never their values on the command line.
 */
export function containerArgs(role, network, names, command, { stdin = false } = {}) {
  return [
    'run',
    '--rm',
    ...(stdin ? ['-i'] : []),
    // An init as PID 1 passes signals on and reaps; psql as PID 1 ignores SIGTERM.
    '--init',
    // Attached output still streams; nothing it prints goes to a log on the host's disk.
    '--log-driver=none',
    `--name=${staging['x-ops-astro'].ownPrefix}-${role}-${randomBytes(8).toString('hex')}`,
    `--network=${network}`,
    ...names.map((name) => `--env=${name}`),
    staging.services.backups.image,
    ...command,
  ];
}

/**
 * Starts `containerArgs(role, network, names of env, command)`, with `env`'s
 * values in the client's environment and `stdin` for a caller that writes to
 * it. Answers the child, `exited` (settles once with whether it succeeded)
 * and `stop()`.
 */
export function runContainer(role, network, env, command, { stdin = false } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'ops-astro-run-'));
  const cidfile = join(folder, 'cid');
  const args = containerArgs(role, network, Object.keys(env), command, { stdin });
  // Docker writes the id once it has made the container, and refuses to run if the file exists.
  args.splice(1, 0, `--cidfile=${cidfile}`);
  const child = spawn('docker', args, {
    env: { ...process.env, ...env },
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'ignore'],
  });
  const name = args.find((arg) => arg.startsWith('--name=')).slice('--name='.length);
  const closed = new Promise((resolve) => {
    child.once('error', () => resolve(false));
    child.once('close', (code, signal) => resolve(code === 0 && !signal));
  });
  // Once the client has closed, nothing of the run is left: a failed run's
  // container goes by the id docker wrote, or by the run's own name when
  // docker had not written it yet (a stop during create).
  const exited = closed.then(async (succeeded) => {
    if (!succeeded) await removeContainer(cidfile, name);
    rmSync(folder, { recursive: true, force: true });
    return succeeded;
  });
  // psql and pg_dump ask the server to cancel the statement they are on when
  // they get SIGINT, so the server's side ends as well (a backend blocked in a
  // statement never notices its client go). The init passes the signal on.
  // Whatever still runs after `GRACE_MS` is removed by its id, so the client
  // sees it end; then the client is asked to end, and killed if it has not.
  async function stop() {
    if (await dockerOn(cidfile, ['kill', '--signal=INT'])) await settles(closed, GRACE_MS);
    await removeContainer(cidfile);
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), GRACE_MS);
    await exited;
    clearTimeout(kill);
  }
  return { child, exited, stop };
}

/** Runs `docker <command> <id>` for the id in `cidfile`; whether there was one. */
async function dockerOn(cidfile, command) {
  let id = '';
  try {
    id = readFileSync(cidfile, 'utf8').trim();
  } catch {
    // Docker has not made the file yet.
  }
  if (!/^[0-9a-f]{64}$/u.test(id)) return false;
  await new Promise((resolve) => {
    execFile('docker', [...command, id], { timeout: STOP_MS }, () => resolve());
  });
  return true;
}

/** Whether `promise` settles within `ms`. */
function settles(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      return resolve(true);
    });
  });
}

/**
 * Removes the container whose id docker wrote to `cidfile`. Docker opens the
 * file empty before it asks the daemon to make the container and writes the
 * id once it has: with `name`, an empty file means a create under way, and the
 * container of that name goes. A run's name is its own (64 random bits), so it
 * is never another run's container. No file means docker made nothing.
 */
async function removeContainer(cidfile, name) {
  const remove = ['rm', '--force', '--volumes'];
  if ((await dockerOn(cidfile, remove)) || name === undefined || !existsSync(cidfile)) return;
  await new Promise((resolve) => {
    execFile('docker', [...remove, name], { timeout: STOP_MS }, () => resolve());
  });
}
