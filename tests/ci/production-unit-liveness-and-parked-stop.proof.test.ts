// SPDX-License-Identifier: AGPL-3.0-only
// Independent review of 2ee177e. All Docker names and volumes belong to this run.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readDefinition } from '../../scripts/ops/deploy.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 });

it('Sol proof, criterion 7: the new container proof is excluded while browser captures run', () => {
  const target = 'tests/ci/production-unit-parks-and-runs-the-worker.proof.test.ts';
  const listed = spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'list', '--filesOnly', target,
  ], {
    env: { ...process.env, CONTAINER_SUITES: 'apart' },
    encoding: 'utf8', timeout: 90_000,
  });
  expect(listed.error).toBeUndefined();
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout, 'the capture phase must not collect a suite that creates Docker networks')
    .not.toContain(target);
});


it('Sol proof, criterion correctness: the gated stop records success when production has a forwarder and no worker', async () => {
  const prefix = `sol1357-parked-stop-${process.pid}`;
  const forwarder = `${prefix}-forwarder`;
  const absentWorker = `${prefix}-worker`;
  const image = String(readDefinition('production').services.forwarder?.image);
  docker(['run', '--detach', '--name', forwarder, image, 'sleep', '3600']);
  const records: unknown[] = [];
  const failures: string[] = [];
  let exitCode = 0;
  const source = read('scripts/ops/stop-production.mjs').replace(/^import .*;\n/gmu, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('spawnSync', 'recordDeployment', 'requireOperatingOperator', 'process', 'console', source);
  try {
    await run(
      (command: string, args: string[]) => {
        expect(command).toBe('docker');
        const isolatedArgs = args.map(arg => arg === 'ops-astro-worker' ? absentWorker
          : arg === 'ops-astro-forwarder' ? forwarder : arg);
        if (isolatedArgs[0] === 'stop') isolatedArgs.splice(1, 0, '--time', '0');
        return spawnSync(command, isolatedArgs, { encoding: 'utf8' });
      },
      async (_gate: unknown, record: unknown) => { records.push(record); return record; },
      async () => ({ ok: true }),
      { argv: ['node', 'stop-production.mjs'], exit: (code: number) => { exitCode = code; throw new Error(`exit ${code}`); } },
      { error: (message: string) => failures.push(message), log: () => {} },
    ).catch((error: Error) => { if (!/^exit [0-9]+$/u.test(error.message)) throw error; });
    expect(docker(['inspect', '--format', '{{.State.Running}}', forwarder]).trim()).toBe('false');
    expect({ exitCode, records: records.length, failures }, 'the sole running member was stopped and the absent member was already stopped').toMatchObject({ exitCode: 0, records: 1 });
  } finally {
    docker(['rm', '--force', '--volumes', forwarder]);
  }
});
