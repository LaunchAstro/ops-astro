// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each proof drives a real script end to end */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { parse } from 'yaml';
import { PROTECTED, protectedVerdicts } from '../../scripts/local/journey-proofs.ts';
import { readNamedSuites } from '../../scripts/named-suites.ts';

const root = resolve(import.meta.dirname, '../..');
function executable(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

test('an exited recorded PID does not abort cleanup of the remaining processes and container', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sol-1365-cleanup-'));
  const departed = spawn('true', [], { stdio: 'ignore' });
  await new Promise((done) => {
    departed.once('exit', done);
  });
  const live = spawn('sleep', ['300'], { stdio: 'ignore' });
  await new Promise((done) => {
    live.once('spawn', done);
  });
  const evidence = join(dir, 'evidence');
  const log = join(dir, 'docker.log');
  const start = 'Mon Oct 12 12:00:00 2026';
  const docker = executable(
    join(dir, 'docker'),
    `
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  image) exit 0 ;;
  inspect) exit 1 ;;
  run)
    printf '%s\\n' '${departed.pid} ${start}' '${live.pid} ${start}' >> '${evidence}.pids'
    printf '%s\\n' '${'a'.repeat(64)}'
    exit 0 ;;
  exec) [ "$3" = pg_isready ] && exit 0; exit 23 ;;
  rm) exit 0 ;;
esac
`,
  );
  executable(
    join(dir, 'ps'),
    `
[ "$4" = '${departed.pid}' ] && exit 1
[ "$4" = '${live.pid}' ] && printf '%s\\n' '${start}'
`,
  );
  executable(join(dir, 'nc'), 'exit 1\n');
  executable(join(dir, 'git'), "printf '%s\\n' f310c54f587b055c79136705aeef8c835d5c5739\n");
  try {
    const run = spawnSync(
      'bash',
      [
        'scripts/local/restart-proof.sh',
        '--name',
        'sol-1365-cleanup',
        '--port',
        '64051',
        '--api-port',
        '64052',
        '--evidence',
        evidence,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DOCKER: docker, PATH: `${dir}:${process.env['PATH']}` },
      },
    );
    await new Promise((done) => {
      setTimeout(done, 100);
    });
    assert.match(
      readFileSync(log, 'utf8'),
      /^rm -f -v sol-1365-cleanup$/mu,
      `cleanup must remove its created container after ps reports an exited PID; exit ${run.status}; ${run.stdout}${run.stderr}`,
    );
    assert.equal(live.signalCode, 'SIGKILL');
  } finally {
    live.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [description, key] of [
  ['an anchored escaped key', '&action "us\\u0065s"'],
  ['an anchored tagged key', '&action !!str uses'],
]) {
  test(`the pin gate rejects an unpinned action behind ${description}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sol-1365-pins-'));
    try {
      for (const path of ['scripts', '.github/workflows', 'docs'])
        mkdirSync(join(dir, path), { recursive: true });
      copyFileSync(join(root, 'scripts/pins-check.mjs'), join(dir, 'scripts/pins-check.mjs'));
      writeFileSync(join(dir, 'docs/supply-chain-pins.md'), 'no pins\n');
      const workflow = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - ${key}: actions/checkout@v4\n`;
      assert.equal(parse(workflow).jobs.a.steps[0].uses, 'actions/checkout@v4');
      writeFileSync(join(dir, '.github/workflows/ci.yml'), workflow);
      const run = spawnSync(process.execPath, [join(dir, 'scripts/pins-check.mjs')], {
        encoding: 'utf8',
      });
      assert.equal(run.status, 1, run.stdout + run.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a protected suite with a failed assertion in the current conformance output cannot be green', () => {
  const suites = PROTECTED.flatMap(([, files]) => files);
  const suite = 'tests/records/records-integrity.test.ts';
  const output = [
    `db-conformance: failed assertion in ${suite}\n  a database assertion\nAssertionError: expected false to be true`,
    ...suites.map((file) => `db-conformance: ${file} moved the database counter by 12 in 1.2s.`),
    `db-conformance: ${suites.length} named suite(s), 100 test(s): 99 passed, 1 failed, 0 skipped`,
    'db-conformance: 2 problem(s)',
    '  1 database test(s) failed. See the assertion detail above.',
    `  vitest reported the run as failed, whatever the test counts say:\n          ${suite}: vitest exited with status 1`,
  ].join('\n');
  const verdict = protectedVerdicts(output, readNamedSuites(root)).find(
    (line) => line.case === 'protected: domain model',
  );
  assert.equal(verdict?.status, 'fail', JSON.stringify(verdict));
  // Reading the suite manifest walks the suite folder, slow on a loaded machine.
}, 60_000);
