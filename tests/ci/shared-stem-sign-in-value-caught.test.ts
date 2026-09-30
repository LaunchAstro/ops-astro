// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { scanBundle } from './fixture-bundle.ts';

it('a test sign-in value planted in a shipped module sharing its stem is caught', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-stem-sign-in-value-'));
  const fixture = 'tests/support/sign-in.ts';
  const shipped = 'apps/web/src/session/sign-in.ts';
  const value = 'synthetic-sign-in-value-for-review';
  const dist = join(root, 'apps/web/dist');
  try {
    for (const file of [fixture, shipped]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `export const signInValue = '${value}';\n`);
    }
    mkdirSync(join(root, 'tests/fixture'), { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'asset.js'), `const signInValue = '${value}';\n`);
    writeFileSync(
      join(dist, 'module-graph.json'),
      JSON.stringify({ modules: { [shipped]: [] } }),
    );

    expect(scanBundle(dist, root)).not.toStrictEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
