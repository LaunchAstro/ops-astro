// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

interface JsonReport {
  readonly testResults: readonly {
    readonly assertionResults: readonly { readonly title: string; readonly status: string }[];
  }[];
}

it('MP-1-1 the browser-dependency proof accepts a coloured test summary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sol-pr155-colour-'));
  try {
    // The capture run is real, with colour forced: the wrapper must still be
    // recorded as passed. Its report is read, since a skip also exits 0.
    const report = join(directory, 'report.json');
    const run = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        'tests/visual/harness-capture-needs-browser.test.ts',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1' } },
    );
    const { testResults } = JSON.parse(readFileSync(report, 'utf8')) as JsonReport;
    const output = `${run.stdout}\n${run.stderr}`;
    expect(
      testResults.flatMap((file) => file.assertionResults.map((test) => [test.title, test.status])),
      output,
    ).toEqual([
      ['MP-1-1 the named page capture passes in a browser, and CI without one fails', 'passed'],
    ]);
    expect(run.status, output).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
