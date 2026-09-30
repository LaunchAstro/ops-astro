// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { scanBundle } from './fixture-bundle.ts';

const fixture = 'tests/support/sign-in.ts';
const shipped = 'apps/web/src/session/sign-in.ts';

// eslint-disable-next-line max-lines-per-function -- one disposable repository and its scanner result
function hitsFor(source: string, bundledValue: string) {
  const root = mkdtempSync(join(tmpdir(), 'shared-stem-assembled-'));
  const dist = join(root, 'apps/web/dist');
  try {
    for (const file of [fixture, shipped]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `export const signInValue = ${source};\n`);
    }
    mkdirSync(join(root, 'tests/fixture'), { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'asset.js'), `const signInValue = ${JSON.stringify(bundledValue)};\n`);
    writeFileSync(join(dist, 'module-graph.json'), JSON.stringify({ modules: { [shipped]: [] } }));
    return scanBundle(dist, root).filter((hit) => hit.file === 'asset.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it.each([
  ['single quotes', "'synthetic-sign-in-value'", 'synthetic-sign-in-value'],
  ['double quotes', '"synthetic-sign-in-value"', 'synthetic-sign-in-value'],
  ['backticks', '`synthetic-sign-in-value`', 'synthetic-sign-in-value'],
  ['escaped apostrophe', "'synthetic\\'s-sign-in-value'", "synthetic's-sign-in-value"],
  ['mixed case', '"Synthetic-SIGN-IN-Value"', 'Synthetic-SIGN-IN-Value'],
  ['hex escape', '"synthetic-\\x73ign-in-value"', 'synthetic-sign-in-value'],
  ['Unicode code point escape', '"synthetic-\\u{73}ign-in-value"', 'synthetic-sign-in-value'],
  ['split concatenation', '"synthetic-si" + "gn-in-value"', 'synthetic-sign-in-value'],
  ['split template value', '`synthetic-si${"g"}n-in-value`', 'synthetic-sign-in-value'],
])('a %s sign-in value from test support is caught in the shipped bundle', (_name, source, value) => {
  expect(hitsFor(source, value).length).toBeGreaterThan(0);
});

it('a shared bare stem with no test-only sign-in value leaves the shipped bundle clean', () => {
  expect(hitsFor("'sign-in'", 'sign-in')).toStrictEqual([]);
});
