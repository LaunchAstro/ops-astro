// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import { MODE } from './packet.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

/** The named capture's full title, as `tests/surfaces/mp-1-1-tokens.test.tsx` names it. */
const capture = 'MP-1-1 harness captures: every built page in light and dark at 1480, 900 and 390';

interface JsonReport {
  readonly testResults: readonly {
    readonly assertionResults: readonly { readonly title: string; readonly status: string }[];
  }[];
}

it('MP-1-1 the named page capture passes in a browser, and CI without one fails', async (context) => {
  // Whether the capture's own launcher opens a browser here, decided before
  // the capture runs and never read from its errors. CI installs the browser,
  // so there one that will not open fails the check; locally it is skipped
  // with the reason, never passed.
  const opens = await launchChromium(MODE)
    .then((browser) => browser.close())
    .then(
      () => true,
      () => false,
    );
  if (!opens) {
    if ((process.env['CI'] ?? '') !== '') {
      throw new Error('No browser opens on CI: the named page capture cannot run.');
    }
    context.skip('no browser opens here; pnpm exec playwright install --only-shell chromium');
  }
  // The child's own temp folder: what the capture leaves behind is removed
  // with it, so the parent's temp guard sees nothing.
  const temp = mkdtempSync(join(tmpdir(), 'named-capture-'));
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
      { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: temp } },
    );
    // The capture's own recorded outcome: it ran and passed. Any failure of
    // it, or no run at all, fails the check.
    const { testResults } = JSON.parse(readFileSync(report, 'utf8')) as JsonReport;
    const ran = testResults
      .flatMap((file) => file.assertionResults)
      .filter((test) => test.status === 'passed' || test.status === 'failed')
      .map((test) => [test.title, test.status]);
    const output = `${run.stdout}\n${run.stderr}`;
    expect(ran, output).toEqual([[capture, 'passed']]);
    expect(run.status, output).toBe(0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
