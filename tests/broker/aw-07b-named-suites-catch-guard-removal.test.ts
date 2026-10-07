// SPDX-License-Identifier: AGPL-3.0-only
// AW-07b sender and hook signature: the named suites catch the guard they
// claim to prove. Each guard is removed in a disposable copy of the source,
// the named suites run against it, and at least one named case must fail.
// The copies run the database cases, so they skip without a database.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { dmarcPolicy } from '../../packages/core-connectors/src/index.ts';
import { createSourceMutant, type MutationSpec } from '../support/source-mutant.ts';

const run = promisify(execFile);
// The harness's own check (`databaseUrlFromEnvironment`), not imported: this
// file opens no database itself, the copies do.
const noDatabase = (process.env['DATABASE_ADMIN_URL'] || process.env['DATABASE_URL'] || '') === '';
const mutationIt = noDatabase ? it.skip : it;
const repo = resolve(import.meta.dirname, '../..');
const trees = [
  'packages',
  'apps/api',
  // composeApi reaches apps/worker (alerts/sink.ts), so the mount's own test loads in the copy.
  'apps/worker',
  'tests',
  'scripts',
  'migrations',
  'vitest.config.ts',
  'package.json',
];

// eslint-disable-next-line max-lines-per-function -- one mutation run and every check on its report
async function namedTestsCatch(
  spec: MutationSpec,
  suites: readonly string[],
  count: number,
): Promise<void> {
  const mutant = createSourceMutant({ ...spec, trees });
  try {
    const output = join(mutant.root, 'sol-result.json');
    let exit = 0;
    try {
      await run(
        process.execPath,
        [
          join(repo, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--root',
          mutant.root,
          '--config',
          join(mutant.root, 'vitest.config.ts'),
          '--reporter=json',
          '--outputFile',
          output,
          ...suites,
        ],
        {
          cwd: mutant.root,
          env: { ...process.env, CI: 'false' },
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch (error) {
      const code = Reflect.get(error as object, 'code');
      if (typeof code !== 'number') throw error;
      exit = code;
    }
    const report = JSON.parse(readFileSync(output, 'utf8')) as {
      numTotalTests: number;
      numPassedTests: number;
      numPendingTests: number;
      numFailedTests: number;
      numRuntimeErrorTestSuites: number;
    };
    // A missing suite, skipped world, or setup fault cannot stand in for a caught fault.
    expect(report.numTotalTests, 'all named cases were collected').toBeGreaterThanOrEqual(count);
    expect(report.numPendingTests, 'no database case skipped').toBe(0);
    expect(report.numRuntimeErrorTestSuites ?? 0, 'no setup fault').toBe(0);
    expect(report.numPassedTests, 'positive controls ran').toBeGreaterThan(0);
    console.info(
      `Sol mutation ${spec.file}: ${report.numPassedTests}/${report.numTotalTests} passed; ${report.numFailedTests} failed; exit ${exit}`,
    );
    expect(
      report.numFailedTests,
      'named cases must catch the removed product guard',
    ).toBeGreaterThan(0);
    expect(exit, 'the caught fault must fail the child run').not.toBe(0);
  } finally {
    mutant.dispose();
  }
}

mutationIt(
  'AW-07b sender: the named sender tests fail when the verified-report guard is removed',
  async () => {
    await namedTestsCatch(
      {
        // `fromVerifiedSender`'s check that the report says the sender is verified.
        file: 'packages/core-custody/src/broker-email-route.ts',
        from: '    sender.verified &&\n',
        to: '',
      },
      [
        'tests/broker/aw-07b-sender-mention.test.ts',
        'tests/broker/email-sender-from-outside-verified-subdomain.test.ts',
      ],
      10,
    );
  },
  240_000,
);

mutationIt(
  'AW-07b hook signature: the named hook tests fail when the production route mount is removed',
  async () => {
    await namedTestsCatch(
      {
        file: 'apps/api/server.ts',
        from: 'if (config.mailHook !== undefined) mountMailHook(server, database, config.mailHook);',
        to: 'void config.mailHook;',
      },
      [
        'tests/api/mail-hook-settings.test.ts',
        'tests/api/mail-hook-chunked-body-too-large.test.ts',
        'tests/broker/aw-07b-hook.test.ts',
        'tests/broker/aw-07b-hook-canary.test.ts',
      ],
      13,
    );
  },
  240_000,
);

it('AW-07b sender: a DMARC policy tag with a second equals sign is reported as invalid', () => {
  expect(dmarcPolicy(['v=DMARC1; p=reject=invalid'])).toBe('invalid');
});
