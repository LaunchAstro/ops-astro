// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

/** The part of Vitest's JSON report this test reads: each file and its tests. */
interface JsonReport {
  readonly testResults: readonly {
    readonly name: string;
    readonly assertionResults: readonly { readonly title: string; readonly status: string }[];
  }[];
}

/** Each test of the named file, with how it ended, as the child's report records it. */
function endings(report: string, file: string): (readonly [string, string])[] | undefined {
  const { testResults } = JSON.parse(readFileSync(report, 'utf8')) as JsonReport;
  const found = testResults.find((result) => result.name.endsWith(`/${file}`));
  return found?.assertionResults.map((test) => [test.title, test.status] as const);
}

it('MP-1-1 the browser-dependency proof accepts a coloured test summary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sol-pr155-colour-'));
  try {
    const hook = join(directory, 'child-output.mjs');
    writeFileSync(
      hook,
      [
        "import childProcess from 'node:child_process';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'const original = childProcess.spawnSync;',
        'childProcess.spawnSync = function (command, args, options) {',
        "  if (Array.isArray(args) && args.includes('tests/surfaces/mp-1-1-tokens.test.tsx')) {",
        '    const escape = String.fromCharCode(27);',
        '    return { status: 1, stdout: `Tests ${escape}[1m${escape}[31m1 failed${escape}[39m${escape}[22m (1)`, stderr: "" };',
        '  }',
        '  return original.apply(this, arguments);',
        '};',
        'syncBuiltinESMExports();',
      ].join('\n'),
    );
    // The child's result is read from its JSON report, not its printed
    // summary: a passing run's compact summary does not name the file.
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
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--import ${hook}` },
      },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(endings(report, 'tests/visual/harness-capture-needs-browser.test.ts'), output).toEqual([
      ['MP-1-1 the named page capture requires a browser screenshot', 'passed'],
    ]);
    expect(run.status, output).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
