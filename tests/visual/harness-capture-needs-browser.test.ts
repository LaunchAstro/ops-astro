// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

/** The named capture's full title, as `tests/surfaces/mp-1-1-tokens.test.tsx` names it. */
const capture = 'MP-1-1 harness captures: every built page in light and dark at 1480, 900 and 390';
/** Playwright's own words when no browser is installed where it looks. */
const noBrowser = "browserType.launch: Executable doesn't exist";

interface JsonReport {
  readonly testResults: readonly {
    readonly assertionResults: readonly {
      readonly title: string;
      readonly status: string;
      readonly failureMessages: readonly string[];
    }[];
  }[];
}

/** Each test that ran, with how it ended and whether it ended for want of a browser. */
function ran(report: string): (readonly [string, string, boolean])[] {
  const { testResults } = JSON.parse(readFileSync(report, 'utf8')) as JsonReport;
  return testResults
    .flatMap((file) => file.assertionResults)
    .filter((test) => test.status === 'passed' || test.status === 'failed')
    .map((test) => [
      test.title,
      test.status,
      test.failureMessages.some((message) => message.includes(noBrowser)),
    ]);
}

it('MP-1-1 the named page capture requires a browser screenshot', () => {
  // The child's own temp folder: what Playwright leaves when it cannot launch
  // is removed with it, so the parent's temp guard sees nothing.
  const temp = mkdtempSync(join(tmpdir(), 'no-browser-'));
  try {
    const report = join(temp, 'report.json');
    const run = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        'tests/surfaces/mp-1-1-tokens.test.tsx',
        '--testNamePattern',
        'MP-1-1 harness captures',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: join(tmpdir(), `sol-no-browser-${randomUUID()}`),
          TMPDIR: temp,
        },
      },
    );
    // The capture's own recorded outcome: it ran, and it failed only because
    // no browser could launch. Any other failure is not this proof.
    const output = `${run.stdout}\n${run.stderr}`;
    expect(ran(report), output).toEqual([[capture, 'failed', true]]);
    expect(run.status, 'the named capture test passed with no browser available').not.toBe(0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
