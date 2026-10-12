// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('a signalled stop subprocess cannot record success from its missing-worker diagnostic', async () => {
  const source = readFileSync(new URL('../../scripts/ops/stop-production.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gmu, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('spawnSync', 'recordDeployment', 'requireOperatingOperator', 'process', 'console', source);
  const records: unknown[] = [];
  let result: ReturnType<typeof spawnSync> | undefined;
  let exit = 0;
  let stops = 0;
  await run(
    (command: string, args: string[], options: object) => {
      expect([command, ...args]).toEqual(['docker', 'stop', 'ops-astro-worker', 'ops-astro-forwarder']);
      stops++;
      result = spawnSync('/bin/sh', ['-c', "printf 'Error response from daemon: No such container: ops-astro-worker\\n' >&2; kill -TERM $$"],
        { ...options, stdio: 'pipe', encoding: 'utf8' });
      return result;
    },
    async (_gate: unknown, record: unknown) => { records.push(record); return record; },
    async () => ({ ok: true }),
    { argv: ['node', 'stop-production.mjs'], exit: (code: number) => { exit = code; throw new Error('proof exit'); } },
    { error: () => {}, log: () => {} },
  ).catch((error: Error) => { if (error.message !== 'proof exit') throw error; });
  expect(stops).toBe(1);
  expect(result?.status).toBeNull();
  expect(result?.signal).toBe('SIGTERM');
  expect(String(result?.stderr)).toBe('Error response from daemon: No such container: ops-astro-worker\n');
  expect({ exit, records: records.length }, 'the child died instead of confirming completion of the stop').toEqual({ exit: 1, records: 0 });
});
