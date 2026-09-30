// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { buildIdentifier, readStamp } from '../../apps/web/build-stamp.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

function rowPassesItsPageToIdentity(path: string, name: string): boolean {
  const source = readFileSync(join(root, path), 'utf8');
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} exists in ${path}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  expect(end, `${name} has a body in ${path}`).toBeGreaterThan(start);
  const body = source.slice(start, end).replaceAll(/\/\/.*$/gmu, '');
  return /\b(?:servedIdentity|servedBuild)\(\s*page\s*,/u.test(body);
}

it('I10 R4 and N6 stamp the page they exercise', () => {
  for (const [label, path, name] of [
    ['I10', 'tests/browser/i10-open-page.mjs', 'casesI10OpenPage'],
    ['R4', 'tests/browser/r4-shared-page.mjs', 'casesR4SharedPage'],
    ['N6', 'tests/browser/n6-fenced-revocation.mjs', 'casesN6'],
  ] as const) {
    expect(rowPassesItsPageToIdentity(path, name), `${label} must check its own page`).toBe(true);
  }
});

it('a forged environment identifier cannot name a web build', async () => {
  const expected = buildIdentifier(root);
  const forged = expected.startsWith('0') ? 'ffffffffffff' : '000000000000';
  const previous = process.env['OPS_ASTRO_BUILD_ID'];
  const outDir = mkdtempSync(join(tmpdir(), 'sol-s0-1c-stamp-'));
  process.env['OPS_ASTRO_BUILD_ID'] = forged;
  try {
    let refused = false;
    try {
      await build({
        configFile: join(root, 'apps/web/vite.config.ts'),
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true },
      });
    } catch (error) {
      expect(String(error)).toMatch(/OPS_ASTRO_BUILD_ID.*(?:checkout|match|mismatch|source)/iu);
      refused = true;
    }
    if (!refused) expect(readStamp(outDir), 'the artefact must name its checkout').toBe(expected);
  } finally {
    if (previous === undefined) delete process.env['OPS_ASTRO_BUILD_ID'];
    else process.env['OPS_ASTRO_BUILD_ID'] = previous;
    rmSync(outDir, { recursive: true, force: true });
  }
});
