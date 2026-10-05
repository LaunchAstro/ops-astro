// SPDX-License-Identifier: AGPL-3.0-only
//
// One throwaway container of staging's pinned Postgres image, attached, for
// the backup's dump and every reach of the store (#489, OW-062.2, OW-062.3).
// Its lifetime is the container's, never only the `docker run` client's: a
// client killed or stopped leaves its container running, and psql or pg_dump
// as PID 1 ignores the SIGTERM docker passes on. So each run has a file of its
// own (`--cidfile`): docker opens it empty before it asks the daemon for the
// container and writes the id once it has one, and deletes it if the create
// is cancelled. Stopping removes the container by that id; a stop that finds a
// create still under way waits for the id, and if none comes, removes the
// run's own name (64 random bits, never another run's). A run that ends by a
// signal, or with any code but 0, has failed, and its container is removed too:
// by its id, or by the run's name when docker wrote none (a create whose answer
// was lost leaves the container and deletes the empty file). A removal docker
// refuses is tried again; one it keeps refusing fails the run, naming the
// container, and keeps the id file.
// One case is left: a create the daemon still finishes after the run's
// removal by name (a stalled create past `STOP_MS` more than `GRACE_MS` after
// a stop, or any late finish after a lost answer with no stop) leaves a
// container in `Created`, holding its login; the staging README says how to
// clear it.

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
// How many times a removal docker refuses is asked, and the pause between.
const REMOVE_TRIES = 3;
const REMOVE_PAUSE_MS = 500;

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
  // Docker refuses to run if the file exists already.
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
  const run = { cidfile, name, id: undefined, removal: undefined };
  // Once the client has closed, nothing of the run is left: a failed run's
  // container goes by the id docker wrote, or by the run's own name when
  // docker wrote none. A container docker will not remove fails the run.
  const exited = closed.then(async (succeeded) => {
    if (!succeeded) {
      const left = await removeRun(run);
      if (left !== undefined) throw notRemoved(left, cidfile);
    }
    rmSync(folder, { recursive: true, force: true });
    return succeeded;
  });
  return { child, exited, stop: () => stopRun(run, { child, closed, exited }) };
}

/**
 * Stops a run. psql and pg_dump ask the server to cancel the statement they
 * are on when they get SIGINT, so the server's side ends as well (a backend
 * blocked in a statement never notices its client go); the init passes the
 * signal on. Whatever still runs after `GRACE_MS` is removed by its id, so
 * the client sees it end; then the client is asked to end, and killed if it
 * has not. A create under way is not interrupted, since a client stopped then
 * cancels its request and deletes the file while the daemon may still make
 * the container: the stop waits for the id first, and if none comes, the
 * run's name goes once the client has closed (`exited`), and once more after
 * a pause for a create the daemon finished late. Rejects as `exited` does.
 */
async function stopRun(run, { child, closed, exited }) {
  const creating = existsSync(run.cidfile);
  if (creating) await idOrClose(run.cidfile, closed);
  const id = idOf(run);
  let left;
  if (id !== undefined) {
    await docker(['kill', '--signal=INT', id]);
    await settles(closed, GRACE_MS);
    left = await removeRun(run);
  }
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), GRACE_MS);
  try {
    await exited;
  } finally {
    clearTimeout(kill);
  }
  // A client that closes cleanly after the stop says nothing of a refused removal.
  if (left !== undefined) throw notRemoved(left);
  if (creating && id === undefined) {
    await pause(GRACE_MS);
    if (!(await removed(run.name))) throw notRemoved(run.name);
  }
}

/** The failure of a run whose container docker would not remove, naming it as `left`; no part of its login. */
function notRemoved(ref, cidfile) {
  const kept = cidfile === undefined ? '' : ` (the run's id file ${cidfile} is kept)`;
  return Object.assign(
    new Error(
      `docker would not remove container ${ref}: remove it with docker rm --force --volumes ${ref}${kept}`,
    ),
    { left: ref },
  );
}

/** The id docker wrote for `run`, kept once read; undefined while there is none. */
function idOf(run) {
  let id = '';
  try {
    id = readFileSync(run.cidfile, 'utf8').trim();
  } catch {
    // Docker has not made the file yet, or deleted it.
  }
  if (/^[0-9a-f]{64}$/u.test(id)) run.id = id;
  return run.id;
}

// What docker says when the container is gone, or going by its own `--rm`.
const GONE = ['No such container', 'is already in progress'];

/**
 * Runs `docker <args>`; whether docker did it, found no such container, or
 * is removing it already. With no docker at all, no container was made.
 */
function docker(args) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: STOP_MS }, (error, _stdout, stderr) =>
      resolve(
        error === null ||
          error.code === 'ENOENT' ||
          GONE.some((answer) => String(stderr).includes(answer)),
      ),
    );
  });
}

function pause(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

/** Waits, at most `STOP_MS`, until `cidfile` holds an id or is gone, or the client has closed. */
async function idOrClose(cidfile, closed) {
  for (const end = Date.now() + STOP_MS; Date.now() < end;) {
    let id;
    try {
      id = readFileSync(cidfile, 'utf8').trim();
    } catch {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- one look at the file after another
    if (/^[0-9a-f]{64}$/u.test(id) || (await settles(closed, 100))) return;
  }
}

/**
 * Whether the container `ref` (an id or the run's name) is gone: removed, or
 * never there. A removal docker refuses is asked again, `REMOVE_TRIES` times.
 */
async function removed(ref) {
  for (let tries = 1; ; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one removal after another
    if (await docker(['rm', '--force', '--volumes', ref])) return true;
    if (tries === REMOVE_TRIES) return false;
    // oxlint-disable-next-line no-await-in-loop -- a pause between them
    await pause(REMOVE_PAUSE_MS);
  }
}

/**
 * Removes `run`'s container, once however many ask: by its id, else by its
 * name, since docker may have made it and deleted the empty file (a create
 * under way, or one whose answer was lost). Answers the id or name docker
 * would not remove, or undefined.
 */
function removeRun(run) {
  run.removal ??= (async () => {
    const ref = idOf(run) ?? run.name;
    return (await removed(ref)) ? undefined : ref;
  })();
  return run.removal;
}
