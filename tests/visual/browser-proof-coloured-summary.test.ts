// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

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
    const run = spawnSync(
      process.execPath,
      [vitest, 'run', 'tests/visual/harness-capture-needs-browser.test.ts'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--import ${hook}` },
      },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).toContain('harness-capture-needs-browser.test.ts');
    expect(run.status, output).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
