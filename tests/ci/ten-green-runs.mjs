// SPDX-License-Identifier: AGPL-3.0-only
// CQ-14 ten green runs: the full suite, database suites included, run ten
// times in a row, stopping at the first run that is not green (product issue
// 56). A test that runs past its timeout fails its run, so ten green runs are
// ten runs with no timeout.
//
//   DATABASE_URL=... pnpm test:ten-runs [vitest arguments]
//
// Without DATABASE_URL every database-bound suite skips and a green run proves
// nothing about them, so the runner refuses to start. Arguments after the
// script go to each `vitest run` as they are, such as `--maxWorkers=4` for a
// hosted runner's four cores.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const RUNS = 10;
const vitest = join(import.meta.dirname, '..', '..', 'node_modules', 'vitest', 'vitest.mjs');

if ((process.env['DATABASE_URL'] ?? '') === '') {
  console.error('CQ-14 ten green runs: DATABASE_URL is unset, so the database suites would skip.');
  process.exit(2);
}

for (let run = 1; run <= RUNS; run += 1) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const green = result.status === 0;
  console.log(
    `CQ-14 ten green runs: run ${String(run)} of ${String(RUNS)} ${green ? 'green' : 'RED'} in ${String(seconds)} s`,
  );
  if (!green) process.exit(1);
}
console.log(`CQ-14 ten green runs: ${String(RUNS)} of ${String(RUNS)} green`);
