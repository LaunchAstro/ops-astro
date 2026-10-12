// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createSourceMutant } from '../support/source-mutant.ts';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const suites = [
  'tests/api/live-board-closed-recheck-review.test.ts',
  'tests/api/live-board-revoked-after-final-read-review.test.ts',
  'tests/api/live-board-revoked-during-rejoin-review.test.ts',
  'tests/api/live-board-task-resync-isolation-review.test.ts',
];

const mutations = [
  {
    name: 'task identifiers in resync frames',
    from: "if (!stream.aborted) await stream.writeSSE({ event, data: '' });",
    to: "if (!stream.aborted) await stream.writeSSE({ event, data: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });",
  },
  {
    name: 'discarded task digests',
    from: 'const seen = `${tasks} ${inbox}`;',
    to: 'const seen = inbox;',
  },
];

it.each(mutations)(
  'live-board proofs reject $name',
  async (mutation) => {
    const mutant = createSourceMutant({
      file: 'apps/api/live-board.ts',
      from: mutation.from,
      to: mutation.to,
      trees: [
        'apps',
        'packages',
        'tests',
        'scripts',
        'migrations',
        'vitest.config.ts',
        'package.json',
      ],
    });
    try {
      const reportFile = join(mutant.root, 'proof-result.json');
      let exit = 0;
      try {
        await run(
          process.execPath,
          [
            join(root, 'node_modules/vitest/vitest.mjs'),
            'run',
            '--root',
            mutant.root,
            '--config',
            join(mutant.root, 'vitest.config.ts'),
            '--reporter=json',
            '--outputFile',
            reportFile,
            ...suites,
          ],
          {
            cwd: mutant.root,
            env: { ...process.env, DATABASE_URL: '', DATABASE_ADMIN_URL: '', CI: 'false' },
            timeout: 120_000,
          },
        );
      } catch (cause) {
        const code = Reflect.get(cause as object, 'code');
        if (typeof code !== 'number') throw cause;
        exit = code;
      }
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
        numTotalTests: number;
        numPendingTests: number;
        numFailedTests: number;
        numRuntimeErrorTestSuites: number;
      };
      expect(report.numTotalTests).toBe(5);
      expect(report.numPendingTests).toBe(0);
      expect(report.numRuntimeErrorTestSuites ?? 0).toBe(0);
      expect(
        report.numFailedTests,
        `${mutation.name} must be caught; child exit ${String(exit)}`,
      ).toBeGreaterThan(0);
    } finally {
      mutant.dispose();
    }
  },
  180_000,
);
