// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expect, it } from 'vitest';

it('a computed unmarked issuer exported by a fixture makes the guard red', () => {
  const root = join(import.meta.dirname, '../..');
  const fixture = join(root, 'tests/fixture', `marker-guard-${randomUUID()}.fixture.ts`);
  try {
    writeFileSync(
      fixture,
      "// SPDX-License-Identifier: AGPL-3.0-only\nconst unmarked = () => 'synthetic-unmarked-issuer';\nexport const ISSUER = unmarked();\n",
    );
    const run = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', 'tests/ci/test-only-fixture-values.test.ts', '--no-file-parallelism'],
      { cwd: root, encoding: 'utf8', timeout: 20_000 },
    );
    expect(run.status).not.toBe(0);
    // Red for this export, by the guard's own case, not for any other reason.
    const out = `${run.stdout}${run.stderr}`;
    expect(out).toContain('× no fixture or support module exports an unmarked sign-in value');
    expect(out).toContain(`"fixture/${basename(fixture)}: ISSUER"`);
  } finally {
    rmSync(fixture, { force: true });
  }
}, 30_000);
