// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2's invariant, `no_fallback_in_bundle` (split section 3.2, T4-R3): a
// search of the built web bundle for the strings that would select a fixture
// path finds nothing, and planting one makes the search fail. The bundle is
// the one `scripts/build.mjs` writes; the search reads every file in it and
// the module graph Rollup recorded, so a fixture module that reached the
// bundle is caught by its path even when minifying renamed its exports.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanBundle } from './fixture-bundle.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = join(ROOT, 'apps/web/dist');
const scratch = mkdtempSync(join(tmpdir(), 'no-fallback-'));

/** A copy of the built bundle to plant in; the real one is never edited. */
function copyOfBundle(name: string): string {
  const copy = join(scratch, name);
  cpSync(DIST, copy, { recursive: true });
  return copy;
}

describe('no_fallback_in_bundle', () => {
  beforeAll(() => {
    const built = spawnSync(process.execPath, ['scripts/build.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(built.status, `${built.stdout}${built.stderr}`).toBe(0);
  }, 180_000);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('the shipped bundle carries no fixture selector and no module from tests/', () => {
    expect(scanBundle(DIST)).toStrictEqual([]);
  });

  it('a fixture selector planted in the built script fails, naming the file and the selector', () => {
    const copy = copyOfBundle('planted-string');
    const script = readdirSync(join(copy, 'assets')).find((file) => file.endsWith('.js')) as string;
    appendFileSync(
      join(copy, 'assets', script),
      '\nconsole.log(new URLSearchParams(location.search).get("fixture"));\n',
    );
    expect(scanBundle(copy)).toStrictEqual([{ file: `assets/${script}`, selector: 'fixture' }]);
  });

  it('a fixture module recorded in the module graph fails even with its strings minified away', () => {
    const copy = copyOfBundle('planted-module');
    const graph = JSON.parse(readFileSync(join(copy, 'module-graph.json'), 'utf8')) as {
      modules: Record<string, string[]>;
    };
    graph.modules['apps/web/src/main.tsx']?.push('tests/support/declining-reporter.ts');
    graph.modules['tests/support/declining-reporter.ts'] = [];
    writeFileSync(
      join(copy, 'module-graph.json'),
      JSON.stringify(graph).replaceAll('fixture', 'f'),
    );
    const hits = scanBundle(copy).map((hit) => hit.selector);
    expect(hits).toContain('tests/support/declining-reporter.ts');
  });

  it('the search is not blind: it finds the selectors in the test-only fixture sources themselves', () => {
    const copy = join(scratch, 'sources');
    cpSync(join(ROOT, 'tests/support/declining-reporter.ts'), join(copy, 'declining-reporter.ts'));
    cpSync(join(ROOT, 'tests/fixture/snapshot.ts'), join(copy, 'snapshot.ts'));
    expect(scanBundle(copy).length).toBeGreaterThan(0);
  });
});
