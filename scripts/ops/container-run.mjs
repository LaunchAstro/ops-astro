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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const closed = new Promise((resolve) => {
    child.once('error', () => resolve(false));
    child.once('close', (code, signal) => resolve(code === 0 && !signal));
  });
  let removal;
  const remove = () => (removal ??= removeContainer(cidfile, folder));
  const exited = closed.then(async (succeeded) => {
    if (succeeded) rmSync(folder, { recursive: true, force: true });
    else await remove();
    return succeeded;
  });
  // The container goes first, by its id; then the client, which may not have made one
  // yet: asked to end, and killed if it has not within `GRACE_MS`.
  async function stop() {
    await remove();
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), GRACE_MS);
    await exited;
    clearTimeout(kill);
  }
  return { child, exited, stop };
}

/** Removes the container `cidfile` names, if docker made one, and the run's folder. */
async function removeContainer(cidfile, folder) {
  let id = '';
  try {
    id = readFileSync(cidfile, 'utf8').trim();
  } catch {
    // Docker made no container: nothing of this run is running.
  }
  if (/^[0-9a-f]{64}$/u.test(id)) {
    await new Promise((resolve) => {
      execFile('docker', ['rm', '--force', '--volumes', id], { timeout: STOP_MS }, () => resolve());
    });
  }
  rmSync(folder, { recursive: true, force: true });
}
