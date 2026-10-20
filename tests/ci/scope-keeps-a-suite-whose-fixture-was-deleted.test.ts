// SPDX-License-Identifier: AGPL-3.0-only
//
// Checks by scope: a suite depends on every repository path it names. When a
// fixture it names is deleted at the pull request's head, that deletion still
// puts the suite's area in scope, so its database and isolation checks run.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { areaOf } from '../../scripts/ci-areas.ts';
import { dependentsOf } from '../../scripts/ci-scope.ts';

const tree = mkdtempSync(join(tmpdir(), 'ci-scope-deleted-'));
afterAll(() => rmSync(tree, { recursive: true, force: true }));

describe('checks by scope', () => {
  it('keeps a suite in scope when a fixture it names is deleted', () => {
    const suite = 'tests/db/reads-a-fixture.test.ts';
    mkdirSync(join(tree, 'tests/db'), { recursive: true });
    // The fixture the suite reads is gone at the head; the suite still names it.
    writeFileSync(join(tree, suite), "readFileSync('tests/db/fixtures/rows.json');\n");
    expect(dependentsOf(tree, [suite])('tests/db/fixtures/rows.json')).toStrictEqual([
      areaOf(suite),
    ]);
  });
});
