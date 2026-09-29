// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docker half of the leak check (issue #103, leak A).
//
// A throwaway Postgres container brings a data volume with it, because the
// image declares `VOLUME /var/lib/postgresql`. `docker rm --force` without
// `--volumes` removes the container and leaves the volume, one per run, and
// those filled the disk. Several runs share one Docker, so a run cannot tell
// its own leftovers from a neighbour's by listing them before and after.
// Instead each run tags the containers it starts, and mounts their data volume
// itself under the same tag, so nothing it makes goes untagged; the check then
// lists only what carries this run's tag. tests/ci/docker-leak-cases.mjs
// proves it.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** One run's tag for the containers it starts, and the check on what it left. */
export function leakRun() {
  const id = randomBytes(6).toString('hex');
  const label = `ops-astro.leak-check=${id}`;
  const list = (...args) => {
    const listed = spawnSync('docker', [...args, '--quiet', '--filter', `label=${label}`], {
      encoding: 'utf8',
    });
    if (listed.status !== 0) throw new Error(`docker ${args.join(' ')}: ${listed.stderr}`);
    return listed.stdout.split('\n').filter((line) => line !== '');
  };
  return {
    id,
    label,
    /** `docker run` or `create` arguments: the tag, and the data volume at `path`, tagged. */
    tag: (path) => ['--label', label, '--mount', `type=volume,dst=${path},volume-label=${label}`],
    /** What this run tagged and did not remove, as `container <id>` and `volume <name>`. */
    leftBehind: () => [
      ...list('ps', '--all').map((container) => `container ${container}`),
      ...list('volume', 'ls').map((volume) => `volume ${volume}`),
    ],
  };
}
