// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unpackHead } from './head-snapshot.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('the coloured summary check rejects a capture with a browser error and another failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mixed-capture-failure-'));
  try {
    unpackHead(root, directory);

    writeFileSync(
      join(directory, 'tests/surfaces/mp-1-1-tokens.test.tsx'),
      [
        "import { it } from 'vitest';",
        "it('MP-1-1 harness captures: every built page in light and dark at 1480, 900 and 390', () => {",
        '  throw new AggregateError([',
        '    new Error("browserType.launch: Executable doesn\'t exist"),',
        "    new Error('the capture failed for another reason'),",
        "  ], 'two reasons');",
        '});',
      ].join('\n'),
    );

    const run = spawnSync(
      process.execPath,
      [
        join(directory, 'node_modules/vitest/vitest.mjs'),
        'run',
        'tests/visual/browser-proof-coloured-summary.test.ts',
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
