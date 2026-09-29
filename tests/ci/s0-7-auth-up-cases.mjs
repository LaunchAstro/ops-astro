// SPDX-License-Identifier: AGPL-3.0-only
// S0-7: auth-up.sh reuses the local database container only when it is on the
// pinned Postgres 17 digest with the named 17 volume, as db-up.sh does. The
// real script runs over a PATH whose docker logs every call and answers as a
// machine holding the container described; it stops the script once the
// container is settled, at the network hand-off to GoTrue.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const pinned = 'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

/** Run auth-up.sh against a container as described; `null` is no container. */
function runWith(container) {
  const scratch = mkdtempSync(join(tmpdir(), 's0-7-auth-up-'));
  try {
    const scriptDir = join(scratch, 'scripts/local');
    const bin = join(scratch, 'bin');
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(bin);
    copyFileSync(join(root, 'scripts/local/auth-up.sh'), join(scriptDir, 'auth-up.sh'));
    const calls = join(scratch, 'calls');
    const present = container !== null;
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in
  *Config.Image*) ${present ? `printf '%s\\n' '${container?.image}'` : 'exit 1'} ;;
  *Mounts*) ${present ? `printf '%s\\n' '${container?.volume}'` : 'exit 1'} ;;
  'inspect -f {{.State.Running}} ops-astro-local-pg') ${present ? `printf '%s\\n' ${container?.running}` : 'exit 1'} ;;
  'inspect ops-astro-local-pg') ${present ? 'exit 0' : 'exit 1'} ;;
  'network connect ops-astro-local ops-astro-local-pg') kill -TERM "$PPID" ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    const run = spawnSync('bash', [join(scriptDir, 'auth-up.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(run.signal, 'SIGTERM', `the script did not reach the hand-off: ${run.stderr}`);
    return readFileSync(calls, 'utf8');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const REMOVED = /^rm -f ops-astro-local-pg$/mu;
const STARTED_17 = new RegExp(
  `^run .*-v ops-astro-local-pgdata-17:/var/lib/postgresql/data .*${pinned}$`,
  'mu',
);

test('a 17 container on the old volume is replaced, and 17 starts on the 17 volume', () => {
  const calls = runWith({ image: pinned, volume: 'ops-astro-local-pgdata', running: true });
  assert.match(calls, REMOVED);
  assert.match(calls, STARTED_17);
});

test('a container naming 17 by a tag, not the digest, is replaced', () => {
  const calls = runWith({
    image: 'postgres:17-alpine',
    volume: 'ops-astro-local-pgdata-17',
    running: true,
  });
  assert.match(calls, REMOVED);
  assert.match(calls, STARTED_17);
});

test('a stopped container on another major is replaced, never started', () => {
  const calls = runWith({
    image: 'postgres:18-alpine',
    volume: 'ops-astro-local-pgdata',
    running: false,
  });
  assert.match(calls, REMOVED);
  assert.doesNotMatch(calls, /^start ops-astro-local-pg$/mu);
  assert.match(calls, STARTED_17);
});

test("the contract's own running container is reused as it is", () => {
  const calls = runWith({ image: pinned, volume: 'ops-astro-local-pgdata-17', running: true });
  assert.doesNotMatch(calls, REMOVED);
  assert.doesNotMatch(calls, /^(run|start) /mu);
});

test("the contract's own stopped container is started, not replaced", () => {
  const calls = runWith({ image: pinned, volume: 'ops-astro-local-pgdata-17', running: false });
  assert.doesNotMatch(calls, REMOVED);
  assert.match(calls, /^start ops-astro-local-pg$/mu);
  assert.doesNotMatch(calls, /^run /mu);
});

test('no container: 17 starts on the 17 volume', () => {
  const calls = runWith(null);
  assert.doesNotMatch(calls, REMOVED);
  assert.match(calls, STARTED_17);
});
