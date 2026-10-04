// SPDX-License-Identifier: AGPL-3.0-only
// The split refusal test in named-suites-split.test.ts claims the refused
// command "changes nothing". This runs that exact test against a disposable
// copy whose split command first deletes, or rewrites, the only suite file
// and then refuses as usual: the test must fail both times, so a refusal
// that damages the registry on its way out cannot pass as harmless.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SUITE = 'tests/db/suites/api/a.test.ts.json';
const BODY = JSON.stringify({ kind: 'invariant', isolation: true, why: 'fixture' });
const SELECTED =
  'split, run as a command in the repository, refuses now each suite has its own file and changes nothing';

it.each([
  ['deletes', `rmSync(join(process.cwd(), '${SUITE}'));`, false],
  [
    'rewrites',
    `writeFileSync(join(process.cwd(), '${SUITE}'), JSON.stringify({ kind: 'conformance', isolation: false, why: 'changed' }));`,
    true,
  ],
] as const)(
  'the split refusal test fails when split %s a suite file before refusing',
  (_, damage, kept) => {
    const copy = mkdtempSync(join(tmpdir(), 'split-refusal-'));
    try {
      mkdirSync(join(copy, 'scripts'), { recursive: true });
      mkdirSync(join(copy, 'tests/ci'), { recursive: true });
      mkdirSync(join(copy, 'tests/db/suites/api'), { recursive: true });
      // The test reads the cut parent's manifest through git at load.
      copyFileSync(join(ROOT, '.git'), join(copy, '.git'));
      symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'));
      writeFileSync(join(copy, 'package.json'), JSON.stringify({ type: 'module' }));
      for (const name of ['ci-areas.ts', 'suite-files.ts']) {
        copyFileSync(join(ROOT, 'scripts', name), join(copy, 'scripts', name));
      }
      const original = readFileSync(join(ROOT, 'scripts/named-suites.ts'), 'utf8');
      const marker = 'if (import.meta.main) {';
      expect(original.split(marker)).toHaveLength(2);
      // In the disposable copy only: damage the suite file, then refuse as usual.
      const damaging = original.replace(marker, `${marker}\n  ${damage}`);
      writeFileSync(join(copy, 'scripts/named-suites.ts'), damaging);
      const suiteFile = join(copy, SUITE);
      writeFileSync(suiteFile, BODY);
      copyFileSync(
        join(ROOT, 'tests/ci/named-suites-split.test.ts'),
        join(copy, 'tests/ci/named-suites-split.test.ts'),
      );
      const config = join(copy, 'vitest.config.mjs');
      writeFileSync(config, 'export default { test: { include: ["tests/ci/*.test.ts"] } };\n');
      const report = join(copy, 'report.json');
      const run = spawnSync(
        process.execPath,
        [
          join(ROOT, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--root',
          copy,
          '--config',
          config,
          '--reporter=json',
          `--outputFile=${report}`,
          'tests/ci/named-suites-split.test.ts',
          '-t',
          SELECTED,
        ],
        { cwd: copy, env: { ...process.env, TMPDIR: copy }, encoding: 'utf8', timeout: 60_000 },
      );
      const result = JSON.parse(readFileSync(report, 'utf8')) as {
        testResults: { assertionResults: { fullName: string; status: string }[] }[];
      };
      const assertion = result.testResults
        .flatMap((file) => file.assertionResults)
        .find((test) => test.fullName === SELECTED);
      expect(assertion, run.stdout + run.stderr).toBeDefined();
      // The damage really happened in the copy.
      expect(existsSync(suiteFile)).toBe(kept);
      if (kept) expect(readFileSync(suiteFile, 'utf8')).not.toBe(BODY);
      expect(assertion?.status, 'the refusal test must catch the damaged suite file').toBe(
        'failed',
      );
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  },
  90_000,
);
