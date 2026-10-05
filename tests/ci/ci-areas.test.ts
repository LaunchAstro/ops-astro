// SPDX-License-Identifier: AGPL-3.0-only
// Every path has exactly one area, derived from the path alone, so the
// per-area named-suites and lint baseline files need no hand-kept list and no
// path is ever left without an area (code-factory METHOD Phase 2 step 6).
import { describe, expect, it } from 'vitest';
import { areaOf } from '../../scripts/ci-areas.ts';

describe('areaOf', () => {
  it('names a tests, apps or packages path by its first two segments', () => {
    expect(areaOf('tests/runtime/t2d-settle.test.ts')).toBe('tests-runtime');
    expect(areaOf('tests/fixture/snapshot/clone.test.ts')).toBe('tests-fixture');
    expect(areaOf('apps/web/src/main.ts')).toBe('apps-web');
    expect(areaOf('packages/core-records/src/index.ts')).toBe('packages-core-records');
  });

  it('names any other path by its first segment, without a leading dot', () => {
    expect(areaOf('scripts/db-conformance.mjs')).toBe('scripts');
    expect(areaOf('docs/agents/database-conformance.md')).toBe('docs');
    expect(areaOf('.github/workflows/ci.yml')).toBe('github');
  });

  it('names a root file root, and a file directly under tests, apps or packages by that folder', () => {
    expect(areaOf('package.json')).toBe('root');
    expect(areaOf('tests/placeholder.test.ts')).toBe('tests');
  });

  it('reads a ./ prefix and a Windows separator as the same path', () => {
    expect(areaOf('./tests/api/x.test.ts')).toBe('tests-api');
    expect(areaOf('tests\\api\\x.test.ts')).toBe('tests-api');
  });

  it('refuses a path that is empty, absolute or climbs out of the repository', () => {
    for (const bad of ['', '/etc/passwd', '../outside.ts', 'tests/../../x.ts', 'tests//x.ts']) {
      expect(() => areaOf(bad), bad).toThrow(/not a repository path/u);
    }
  });
});
