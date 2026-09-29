// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const digest17 = 'b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const digest18 = '77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

test('Sol proof, criterion 6: auth-up replaces a running Postgres 18 before using the 17 digest', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-s0-7-auth-'));
  try {
    const scriptDir = join(scratch, 'scripts/local');
    const bin = join(scratch, 'bin');
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(bin);
    copyFileSync(join(root, 'scripts/local/auth-up.sh'), join(scriptDir, 'auth-up.sh'));
    const calls = join(scratch, 'docker-calls');
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$SOL_DOCKER_CALLS"
case "$*" in
  *Config.Image*) printf '%s\\n' 'postgres@sha256:${digest18}' ;;
  *Mounts*) printf '%s\\n' 'ops-astro-local-pgdata' ;;
  'inspect -f {{.State.Running}} ops-astro-local-pg') printf '%s\\n' true ;;
  'network connect ops-astro-local ops-astro-local-pg') kill -TERM "$PPID" ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    const run = spawnSync('bash', [join(scriptDir, 'auth-up.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_DOCKER_CALLS: calls },
      encoding: 'utf8',
      timeout: 5_000,
    });
    const logged = readFileSync(calls, 'utf8');
    assert.match(logged, /^network connect ops-astro-local ops-astro-local-pg$/mu, 'probe did not reach auth handoff');
    assert.equal(run.signal, 'SIGTERM', `unexpected script result: ${run.stderr}`);
    assert.match(logged, /^rm -f ops-astro-local-pg$/mu, 'the running 18 container was reused');
    assert.match(logged, new RegExp(`^run .*postgres@sha256:${digest17}$`, 'mu'), '17 was not started');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
