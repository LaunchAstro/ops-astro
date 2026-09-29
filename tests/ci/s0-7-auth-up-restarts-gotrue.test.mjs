// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('replacing Postgres restarts GoTrue on the new cluster', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-s0-7-gotrue-'));
  try {
    const scriptDir = join(scratch, 'scripts/local');
    const bin = join(scratch, 'bin');
    const local = join(scratch, '.local');
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(bin);
    mkdirSync(local);
    copyFileSync(join(root, 'scripts/local/auth-up.sh'), join(scriptDir, 'auth-up.sh'));
    const key = 'synthetic-test-key';
    writeFileSync(join(local, 'auth-signing-key.json'), key);
    writeFileSync(join(local, 'db.env'), 'DATABASE_URL=synthetic-test-url\n');
    const label = createHash('sha256').update(key).digest('hex').slice(0, 16);
    const calls = join(scratch, 'calls');
    const removed = join(scratch, 'auth-removed');
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
case "$*" in
  'inspect ops-astro-local-pg') exit 0 ;;
  run*'--name ops-astro-local-auth'*)
    printf '%s\\n' run-auth >> '${calls}'
    rm -f '${removed}' ;;
  run*'--name ops-astro-local-pg'*) printf '%s\\n' run-pg >> '${calls}' ;;
  *ops-astro-local-pg*)
    case "$*" in
      *Mounts*) printf '%s\\n' ops-astro-local-pgdata ;;
      *Config.Image*) printf '%s\\n' postgres:18-alpine ;;
      *State.Running*) printf '%s\\n' true ;;
      'rm -f ops-astro-local-pg') printf '%s\\n' rm-pg >> '${calls}' ;;
    esac ;;
  *ops-astro-local-auth*)
    case "$*" in
      *signing-key*) printf '%s\\n' '${label}' ;;
      *State.Running*) if [ -f '${removed}' ]; then exit 1; else printf '%s\\n' true; fi ;;
      'inspect ops-astro-local-auth')
        if [ -f '${removed}' ]; then exit 1; fi
        printf '%s\\n' '"GOTRUE_JWT_ISSUER=http://127.0.0.1:54391"' ;;
      'rm -f ops-astro-local-auth')
        printf '%s\\n' rm-auth >> '${calls}'
        : > '${removed}' ;;
      'restart ops-astro-local-auth') printf '%s\\n' restart-auth >> '${calls}' ;;
      'stop ops-astro-local-auth') printf '%s\\n' stop-auth >> '${calls}' ;;
      'start ops-astro-local-auth') printf '%s\\n' start-auth >> '${calls}' ;;
    esac ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf healthy\\n\n', { mode: 0o755 });
    writeFileSync(join(bin, 'openssl'), '#!/bin/sh\nprintf synthetic-test-secret\n', {
      mode: 0o755,
    });
    const run = spawnSync('bash', [join(scriptDir, 'auth-up.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(run.status, 0, `the simulated auth-up run did not finish: ${run.stderr}`);
    const events = readFileSync(calls, 'utf8').trim().split('\n');
    assert.deepEqual(events.slice(0, 2), ['rm-pg', 'run-pg']);
    const recreated = events.includes('rm-auth') && events.includes('run-auth');
    const restarted =
      events.includes('restart-auth') ||
      (events.includes('stop-auth') && events.includes('start-auth'));
    assert.ok(recreated || restarted, 'GoTrue remained running after its database was replaced');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
