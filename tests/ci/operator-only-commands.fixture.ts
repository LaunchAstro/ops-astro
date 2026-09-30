// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-1e operator-only suites' commands (operator-only.fixture.ts and the
// suites): each person-only command as the owner runs it, over a PATH whose
// docker and launchctl log every call, and the marks it would leave.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { outputDigest } from '../../scripts/ops/build-output.ts';

export const CANARY = 'canary-7c2f41-operator-secret';

export const OPERATOR: string = new URL('../../scripts/ops/operator.mjs', import.meta.url).pathname;

export const PROMOTE: string = new URL('../../scripts/ops/promote.mjs', import.meta.url).pathname;

export const DRILL: string = new URL('../../scripts/ops/restore-drill.mjs', import.meta.url)
  .pathname;

export const DEPLOY: string = new URL('../../scripts/ops/deploy.mjs', import.meta.url).pathname;

export const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as { 'x-ops-astro': { artefact: string } };

export const STAGED = '0123456789ab';

export const LINE = 'Tried the task page and the approval queue on staging; both behave.';

// Made by the file's first hook, so a file whose tests all skip leaves no folder (temp guard).
export const scratch: string = join(tmpdir(), `s0-1e-${randomBytes(6).toString('hex')}`);
beforeAll(() => mkdirSync(scratch, { mode: 0o700 }));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A PATH whose docker and launchctl append every call to `calls` and answer as the live manager. */
export const manager = (apiRunning: boolean): { path: string; calls: string } => {
  const bin = mkdtempSync(join(scratch, 'bin-'));
  const calls = join(bin, 'calls.log');
  const inspect = JSON.stringify([
    { Name: '/prod-api', State: { Running: apiRunning }, HostConfig: {} },
  ]);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "docker $*" >> '${calls}'\nif [ "$1" = ps ]; then echo api-id; exit 0; fi\nif [ "$1" = inspect ]; then printf '%s\\n' '${inspect}'; exit 0; fi\nif [ "$1" = start ]; then exit 0; fi\nif [ "$1" = compose ]; then exit 0; fi\nexit 2\n`,
  );
  writeFileSync(
    join(bin, 'launchctl'),
    `#!/bin/sh\necho "launchctl $*" >> '${calls}'\nprintf 'PID\\tStatus\\tLabel\\n-\\t0\\torg.example.prod-auth\\n'\n`,
  );
  for (const command of ['docker', 'launchctl']) chmodSync(join(bin, command), 0o755);
  return { path: `${bin}:${process.env['PATH'] ?? ''}`, calls };
};

export const store = (): string => {
  const root = mkdtempSync(join(scratch, 'store-'));
  const build = join(root, definition['x-ops-astro'].artefact.replace('{version}', STAGED));
  mkdirSync(build);
  writeFileSync(join(build, 'build.json'), JSON.stringify({ build: STAGED }));
  writeFileSync(
    join(build, 'build.json'),
    JSON.stringify({ build: STAGED, digest: outputDigest(build) }),
  );
  return root;
};

export interface Run {
  readonly status: number | null;
  readonly out: string;
}

export const spawn = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): Run => {
  const result = spawnSync(process.execPath, [command, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

/** Where one command's attempt can leave a mark: the link, the record folder, the manager's log. */
export interface Marks {
  readonly current: string;
  readonly records: string;
  readonly calls: string;
}

export const marks = (fake: { calls: string }): Marks => {
  const current = join(mkdtempSync(join(scratch, 'prod-')), 'current');
  symlinkSync(join(scratch, 'previous-build'), current);
  const records = mkdtempSync(join(scratch, 'records-'));
  return { current, records, calls: fake.calls };
};

export type Command = (env: Record<string, string>, at: Marks) => Run;

/** A private key file holding only the canary: a drill that read it could only leak it. */
export const drillKey = (): string => {
  const file = join(mkdtempSync(join(scratch, 'key-')), 'restore.key');
  writeFileSync(file, `${CANARY}\n`);
  return file;
};

export const COMMANDS: Record<string, Command> = {
  'staging preparation': (env) => spawn(OPERATOR, ['prepare'], env),
  // S0-3 operator only: the drill's store, key and scope are all set, so a
  // drill that skipped the gate would reach for them; a refused one never does.
  'the restore drill': (env) =>
    spawn(DRILL, ['--drill'], {
      RESTORE_STORE_URL: `postgres://drill:${CANARY}@127.0.0.1:1/never`,
      RESTORE_KEY_FILE: drillKey(),
      DRILL_BUSINESS_ID: randomUUID(),
      DRILL_CLIENT_ID: randomUUID(),
      DRILL_PERSON_ID: randomUUID(),
      ...env,
    }),
  // S0-3e operator only: the carried archive's three steps. A refused export
  // writes no file (it would land in the record folder); a refused carried
  // drill or record never reads its file, which holds only the canary.
  'the archive export': (env, at) =>
    spawn(DRILL, ['--export', join(at.records, 'archive.sealed')], {
      RESTORE_STORE_URL: `postgres://drill:${CANARY}@127.0.0.1:1/never`,
      ...env,
    }),
  'the carried-archive drill': (env) =>
    spawn(DRILL, ['--drill', '--archive', drillKey()], {
      RESTORE_KEY_FILE: drillKey(),
      DRILL_BUSINESS_ID: randomUUID(),
      DRILL_CLIENT_ID: randomUUID(),
      DRILL_PERSON_ID: randomUUID(),
      ...env,
    }),
  'the carried receipt record': (env) =>
    spawn(DRILL, ['--record', drillKey(), '--archive', drillKey()], {
      RESTORE_STORE_URL: `postgres://drill:${CANARY}@127.0.0.1:1/never`,
      ...env,
    }),
  // S0-6 operator only: a deploy of a stored build to staging.
  'the staging deploy': (env) => spawn(DEPLOY, ['--version', STAGED, '--artefacts', store()], env),
  'the promotion step': (env, at) =>
    spawn(
      PROMOTE,
      [
        '--version',
        STAGED,
        '--artefacts',
        store(),
        '--line',
        LINE,
        '--api',
        'docker:prod-api',
        '--auth',
        'launchd:org.example.prod-auth',
        '--current',
        at.current,
      ],
      env,
    ),
};
