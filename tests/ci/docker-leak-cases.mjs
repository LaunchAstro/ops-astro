// SPDX-License-Identifier: AGPL-3.0-only
// The Docker half of the leak check (issue #103, leak A), proven.
//
// The Postgres image declares `VOLUME /var/lib/postgresql`, so every container
// gets a data volume, and `docker rm --force` without `--volumes` leaves it
// behind: 2,256 of them, 124.7 GB, by 29 September. A run tags what it starts
// with its own label, and its check fails on any tagged container or volume
// still there at the end. Runs side by side carry different labels, so one
// never counts the other's.
//
// Needs Docker. Without it these cases skip, except in CI, where the
// `database conformance gate` job has Docker and a skip would prove nothing.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { leakRun } from '../support/docker-leak.mjs';

const IMAGE = 'postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

const skipUnlessDocker = (t) => {
  if (docker('info', '--format', '{{.ServerVersion}}').status === 0) return false;
  const ci = (process.env['CI'] ?? '').trim().toLowerCase();
  assert.ok(ci === '' || ci === 'false' || ci === '0', 'Docker is not available and CI is set');
  t.skip('Docker is not available');
  return true;
};

/** A Postgres container created (not started) under `run`'s tag, removed with `removeArgs`. */
function plant(run, removeArgs) {
  const name = `ops-astro-leak-check-${run.id}`;
  const created = docker('create', '--name', name, ...run.tag('/var/lib/postgresql'), IMAGE);
  assert.equal(created.status, 0, created.stderr);
  const mounts = docker('inspect', name, '--format', '{{len .Mounts}}').stdout.trim();
  docker('rm', ...removeArgs, name);
  return mounts;
}

/** Whatever `run` tagged, removed, so a failing case leaves nothing either. */
function sweep(run) {
  for (const line of run.leftBehind()) {
    const [kind, id] = line.split(' ');
    docker(
      ...(kind === 'volume' ? ['volume', 'rm', '--force'] : ['rm', '--force', '--volumes']),
      id,
    );
  }
}

test('a container removed without --volumes leaves its tagged data volume, and the check names it', (t) => {
  if (skipUnlessDocker(t)) return;
  const run = leakRun();
  try {
    // The tagged mount replaces the image's own volume, so none goes untagged.
    assert.equal(plant(run, ['--force']), '1');
    const left = run.leftBehind();
    assert.equal(left.length, 1, left.join('\n'));
    assert.match(left[0] ?? '', /^volume \S+$/u);
  } finally {
    sweep(run);
  }
});

test('with --volumes nothing is left, and a volume another run tagged does not count', (t) => {
  if (skipUnlessDocker(t)) return;
  const [run, other] = [leakRun(), leakRun()];
  const neighbour = docker('volume', 'create', '--label', other.label);
  assert.equal(neighbour.status, 0, neighbour.stderr);
  try {
    assert.equal(plant(run, ['--force', '--volumes']), '1');
    assert.deepEqual(run.leftBehind(), []);
    assert.equal(other.leftBehind().length, 1);
  } finally {
    sweep(run);
    sweep(other);
  }
});
