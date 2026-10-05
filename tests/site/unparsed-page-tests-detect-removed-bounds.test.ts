// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createSourceMutant } from '../support/source-mutant.ts';

it('the unparsed-page tests detect removal of the pre-parse bounds', () => {
  const mutant = createSourceMutant({
    file: 'packages/core-connectors/src/site/envelope.ts',
    from: 'if (tooLarge(file.before) || tooLarge(file.after)) {',
    to: 'if (false) {',
  });
  const copiedTest = resolve('tests/site/sol-820-unparsed-mutant.test.ts');
  try {
    const prefix = `../../${relative(process.cwd(), mutant.root)}/packages/`;
    const original = readFileSync(
      'tests/site/envelope-parser-bounds-and-text-edges.test.ts',
      'utf8',
    );
    writeFileSync(copiedTest, original.replaceAll('../../packages/', prefix));
    const run = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        copiedTest,
        '-t',
        'refuses a page of .* unparsed and the host lives on',
      ],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    expect(run.error, run.stderr).toBeUndefined();
    // oxlint-disable-next-line no-control-regex, unicorn/escape-case, unicorn/no-hex-escape -- strips the child run's colour codes
    const summary = run.stdout.replaceAll(/\x1b\[[\d;]*m/gu, '');
    expect(summary).toMatch(/\b2 (?:passed|failed)\b/u);
    expect(
      run.status,
      'Removing both pre-parse bounds leaves the two named refusal tests green',
    ).not.toBe(0);
  } finally {
    rmSync(copiedTest, { force: true });
    mutant.dispose();
  }
}, 90_000);
