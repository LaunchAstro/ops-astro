// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const image17 = 'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

const DOCKER_FAKE = `#!/bin/sh
case "$1" in
  volume|network|exec) exit 0 ;;
  inspect)
    case "$*" in
      *ops-astro-local-pg*)
        stage=$(cat '__PGSTATE__')
        [ "$stage" != absent ] || exit 1
        case "$*" in
          *State.Status*) printf '%s\\n' running ;;
          *State.Running*) printf '%s\\n' true ;;
          *Config.Image*) if [ "$stage" = 18 ]; then printf '%s\\n' postgres:18-alpine; else printf '%s\\n' '__IMAGE17__'; fi ;;
          *Mounts*) if [ "$stage" = 18 ]; then printf '%s\\n' ops-astro-local-pgdata; else printf '%s\\n' ops-astro-local-pgdata-17; fi ;;
          *Id*) printf '%s\\n' "pg-$stage" ;;
        esac ;;
      *ops-astro-local-auth*)
        [ "$(cat '__AUTHSTATE__')" != absent ] || exit 1
        case "$*" in
          *State.Running*) printf '%s\\n' true ;;
          *signing-key*) printf '%s\\n' '__LABEL__' ;;
          *Config.Labels*) printf '%s\\n' pg-18 ;;
          *) printf '%s\\n' '"GOTRUE_JWT_ISSUER=http://127.0.0.1:54391"' ;;
        esac ;;
    esac ;;
  rm)
    if [ "$3" = ops-astro-local-pg ]; then
      printf '%s\\n' absent > '__PGSTATE__'
      printf '%s\\n' rm-pg >> '__CALLS__'
    else
      printf '%s\\n' absent > '__AUTHSTATE__'
      printf '%s\\n' rm-auth >> '__CALLS__'
    fi ;;
  run)
    case "$*" in
      *'--name ops-astro-local-pg'*) printf '%s\\n' 17 > '__PGSTATE__'; printf '%s\\n' run-pg >> '__CALLS__' ;;
      *'--name ops-astro-local-auth'*) printf '%s\\n' running > '__AUTHSTATE__'; printf '%s\\n' run-auth >> '__CALLS__' ;;
    esac ;;
  restart) printf '%s\\n' restart-auth >> '__CALLS__' ;;
  stop) printf '%s\\n' stop-auth >> '__CALLS__' ;;
  start) printf '%s\\n' start-auth >> '__CALLS__' ;;
esac
exit 0
`;

test('db-up replacing Postgres makes auth-up remigrate GoTrue', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-s0-7-start-order-'));
  try {
    const scriptDir = join(scratch, 'scripts/local');
    const bin = join(scratch, 'bin');
    const local = join(scratch, '.local');
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(bin);
    mkdirSync(local);
    for (const script of ['db-up.sh', 'auth-up.sh'])
      copyFileSync(join(root, 'scripts/local', script), join(scriptDir, script));
    const key = 'synthetic-test-key';
    writeFileSync(join(local, 'auth-signing-key.json'), key);
    writeFileSync(join(local, 'db.env'), 'APP_PASSWORD=synthetic-test-password\n');
    const label = createHash('sha256').update(key).digest('hex').slice(0, 16);
    const pgState = join(scratch, 'pg-state');
    const authState = join(scratch, 'auth-state');
    const calls = join(scratch, 'calls');
    writeFileSync(pgState, '18');
    writeFileSync(authState, 'running');
    const fakeDocker = DOCKER_FAKE.replaceAll('__PGSTATE__', pgState)
      .replaceAll('__AUTHSTATE__', authState)
      .replaceAll('__CALLS__', calls)
      .replaceAll('__IMAGE17__', image17)
      .replaceAll('__LABEL__', label);
    writeFileSync(join(bin, 'docker'), fakeDocker, { mode: 0o755 });
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf healthy\\n\n', { mode: 0o755 });
    writeFileSync(join(bin, 'openssl'), '#!/bin/sh\nprintf synthetic-test-secret\n', {
      mode: 0o755,
    });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    for (const script of ['db-up.sh', 'auth-up.sh']) {
      const run = spawnSync('bash', [join(scriptDir, script)], {
        env,
        encoding: 'utf8',
        timeout: 5_000,
      });
      assert.equal(run.status, 0, `${script} did not finish: ${run.stderr}`);
    }
    const events = readFileSync(calls, 'utf8').trim().split('\n');
    assert.deepEqual(events.slice(0, 2), ['rm-pg', 'run-pg']);
    const recreated = events.includes('rm-auth') && events.includes('run-auth');
    const restarted =
      events.includes('restart-auth') ||
      (events.includes('stop-auth') && events.includes('start-auth'));
    assert.ok(recreated || restarted, 'auth-up kept GoTrue from the Postgres 18 cluster');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
