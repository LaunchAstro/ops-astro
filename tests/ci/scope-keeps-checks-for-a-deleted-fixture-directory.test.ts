// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkRuns, dependentsOf, scopeOf } from '../../scripts/ci-scope.ts';

it('deleting a named fixture directory keeps its database and isolation checks in scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'sol-1386-deleted-dir-'));
  const suite = 'tests/db/reads-fixtures.test.ts';
  const fixture = 'tests/db/fixtures/rows.json';
  const map = {
    scopable: ['tests/'],
    runsEverything: [],
    visualDrift: [],
    queueOnly: [],
    alwaysRunTests: [],
  };
  try {
    mkdirSync(join(root, 'tests/db/fixtures'), { recursive: true });
    writeFileSync(join(root, fixture), '[]');
    writeFileSync(
      join(root, suite),
      "import { readdirSync } from 'node:fs';\nreaddirSync('tests/db/fixtures');\n",
    );
    const before = scopeOf('pull_request', [fixture], map, dependentsOf(root, [suite]));
    expect(checkRuns('database conformance', before, [fixture], map, [suite])).toBe(true);
    rmSync(join(root, 'tests/db/fixtures'), { recursive: true });
    const after = scopeOf('pull_request', [fixture], map, dependentsOf(root, [suite]));
    expect.soft(checkRuns('database conformance', after, [fixture], map, [suite])).toBe(true);
    expect.soft(checkRuns('isolation tests', after, [fixture], map, [suite])).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
