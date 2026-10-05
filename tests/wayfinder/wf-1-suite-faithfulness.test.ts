// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

/** The named suites it runs need a database: without one they skip, so this case would see no failure. */
const withDatabase = it.skipIf(databaseUrlFromEnvironment() === undefined);

withDatabase(
  'WF-1 the named WF-1 suites reject a frontier implementation returning empty lists',
  async () => {
    const root = resolve(import.meta.dirname, '../..');
    const copy = mkdtempSync(join(tmpdir(), 'sol379-frontier-'));
    try {
      for (const directory of ['apps', 'packages', 'scripts', 'tests']) {
        cpSync(join(root, directory), join(copy, directory), { recursive: true });
      }
      for (const file of ['package.json', 'vitest.config.ts']) {
        cpSync(join(root, file), join(copy, file));
      }
      for (const directory of ['node_modules', 'migrations']) {
        symlinkSync(join(root, directory), join(copy, directory), 'dir');
      }
      const file = join(copy, 'packages/core-commands/src/reads/maps.ts');
      const source = readFileSync(file, 'utf8');
      const anchor = '  const frontier = await tx.query<{';
      expect(source.split(anchor)).toHaveLength(2);
      writeFileSync(
        file,
        source.replace(anchor, '  return { ok: true, frontier: [], fog: [] };\n' + anchor),
      );
      const run = promisify(execFile);
      const outcome = await run(
        process.execPath,
        [
          join(root, 'node_modules/vitest/vitest.mjs'),
          'run',
          'tests/wayfinder/wf-1.test.ts',
          'tests/wayfinder/wf-1-cli.test.ts',
        ],
        { cwd: copy, env: process.env, timeout: 180_000, maxBuffer: 4_000_000 },
      ).then(
        (answer) => ({ status: 0, output: answer.stdout + answer.stderr }),
        (error: { code: number; stdout: string; stderr: string }) => ({
          status: error.code,
          output: error.stdout + error.stderr,
        }),
      );
      expect(outcome.status, outcome.output).toBe(1);
      expect(outcome.output).toContain('AssertionError');
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  },
  200_000,
);
