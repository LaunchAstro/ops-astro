// SPDX-License-Identifier: AGPL-3.0-only
//
// The runner and its install check refuse what would hang or mislead them: a
// settings file that is a pipe is refused without waiting on a writer, a git
// checkout reached through a linked ancestor still holds the runner home, and
// the custody refusal case fails when the check never ran. All inputs are
// synthetic; no model or sign-in is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { RUNNER_KEY } from './world.ts';

const root = resolve(import.meta.dirname, '../..');
const check = join(root, 'scripts/m5/gpt-runner-install-check.sh');
const key = RUNNER_KEY;
const path = process.env['PATH'] ?? '/usr/bin:/bin';

test('a settings FIFO is refused without blocking runner startup', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'settings-pipe-')));
  try {
    const fifo = join(dir, 'settings.json');
    const made = spawnSync('mkfifo', ['-m', '600', fifo], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    // No writer exists: open(O_RDONLY) blocks before fstat can reject the FIFO.
    const ran = spawnSync(process.execPath, [join(root, 'apps/local-agent/main.ts')], {
      env: { PATH: path, OPS_ENVIRONMENT: 'local', OPS_LOCAL_AGENT_SETTINGS: fifo },
      encoding: 'utf8',
      timeout: 1500,
      killSignal: 'SIGKILL',
    });
    assert.equal(
      (ran.error as NodeJS.ErrnoException | undefined)?.code,
      undefined,
      'runner blocked opening a settings FIFO instead of refusing it',
    );
    assert.equal(ran.status, 1, ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// eslint-disable-next-line max-lines-per-function -- one case, kept whole as first written
test('an ancestor symlink cannot hide the git checkout containing the runner home', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'linked-home-')));
  try {
    const repo = join(dir, 'repository');
    const nested = join(repo, 'nested');
    mkdirSync(join(nested, 'agent', 'codex'), { recursive: true, mode: 0o700 });
    mkdirSync(join(nested, 'agent', 'cwd'), { mode: 0o700 });
    const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    writeFileSync(
      join(repo, 'AGENTS.md'),
      'Synthetic repository instructions that must not enter a runner call.\n',
    );
    const alias = join(dir, 'alias');
    symlinkSync(nested, alias);
    const home = join(alias, 'agent');
    const discovered = spawnSync('git', ['-C', join(home, 'cwd'), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    });
    assert.equal(discovered.status, 0, discovered.stderr);
    assert.equal(discovered.stdout.trim(), realpathSync(repo));
    const settings = join(dir, 'settings.json');
    const credentials = join(dir, 'credentials.json');
    writeFileSync(
      settings,
      JSON.stringify({
        OPS_LOCAL_AGENT_SITE: 'm5',
        OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1',
        OPS_LOCAL_AGENT_HOME: home,
        OPS_LOCAL_AGENT_CODEX_BIN: join(root, 'tests/local-agent/fake-codex.mjs'),
        OPS_LOCAL_AGENT_KEY: key,
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      credentials,
      JSON.stringify([
        {
          ref: 'local_runner',
          kind: 'api_key',
          account: 'synthetic',
          destination: 'local_gpt',
          header: 'authorization',
          value: key,
        },
      ]),
      { mode: 0o600 },
    );
    const ran = spawnSync('/bin/sh', [check, settings, credentials], {
      env: { PATH: path },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(ran.error, undefined);
    assert.notEqual(ran.status, 0, `preflight certified a home inside ${repo}: ${ran.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'the custody refusal test fails when the install checker never runs',
  { timeout: 30_000 },
  // eslint-disable-next-line max-lines-per-function -- one case, kept whole as first written
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'no-check-')));
    try {
      const tests = join(dir, 'tests/local-agent');
      mkdirSync(tests, { recursive: true });
      const named =
        'the-install-check-certifies-only-a-credential-custody-loads-and-a-listener-read-that-completes.test.ts';
      for (const file of [named, 'world.ts', 'fake-codex.mjs', 'fake-codex-app.mjs']) {
        cpSync(join(root, 'tests/local-agent', file), join(tests, file));
      }
      for (const entry of ['packages', 'apps', 'node_modules'])
        symlinkSync(join(root, entry), join(dir, entry));
      // Deliberately no scripts/m5/gpt-runner-install-check.sh in this test root.
      const config = join(dir, 'vitest.config.mjs');
      writeFileSync(
        config,
        'export default { test: { environment: "node", include: ["tests/**/*.test.ts"] } };\n',
      );
      const report = join(dir, 'result.json');
      const ran = spawnSync(
        process.execPath,
        [
          join(root, 'node_modules/vitest/vitest.mjs'),
          'run',
          join(tests, named),
          '--config',
          config,
          '--configLoader=native',
          '-t',
          'the install check refuses a credential file custody cannot load',
          '--reporter=json',
          `--outputFile=${report}`,
        ],
        {
          cwd: dir,
          // The nested run keeps its temporary files in this test's own folder.
          env: { ...process.env, TMPDIR: dir },
          encoding: 'utf8',
          timeout: 15000,
        },
      );
      assert.equal(ran.error, undefined);
      const result = JSON.parse(readFileSync(report, 'utf8'));
      assert.equal(
        result.numPassedTests + result.numFailedTests,
        1,
        JSON.stringify({ status: ran.status, stderr: ran.stderr, tests: result.testResults }),
      );
      assert.notEqual(
        ran.status,
        0,
        'the named custody refusal test passed solely because /bin/sh could not find the checker',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
