// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { scanBundle } from './fixture-bundle.ts';

const fixture = 'tests/support/sign-in.ts';
const shipped = 'apps/web/src/session/sign-in.ts';

it.each([
  ['mixed case', '"Synthetic-SIGN-IN-Value"', 'Synthetic-SIGN-IN-Value'],
  ['apostrophe inside double quotes', '"synthetic\'s-sign-in-value"', "synthetic's-sign-in-value"],
  ['Unicode escape', '"synthetic-\\u0073ign-in-value"', 'synthetic-sign-in-value'],
])('a %s test sign-in value in a shipped module and bundle is caught', (_name, source, value) => {
  const root = mkdtempSync(join(tmpdir(), 'shared-stem-hostile-'));
  const dist = join(root, 'apps/web/dist');
  try {
    for (const file of [fixture, shipped]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `export const signInValue = ${source};\n`);
    }
    mkdirSync(join(root, 'tests/fixture'), { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'asset.js'), `const signInValue = ${JSON.stringify(value)};\n`);
    writeFileSync(join(dist, 'module-graph.json'), JSON.stringify({ modules: { [shipped]: [] } }));

    expect(scanBundle(dist, root).some((hit) => hit.file === 'asset.js')).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
