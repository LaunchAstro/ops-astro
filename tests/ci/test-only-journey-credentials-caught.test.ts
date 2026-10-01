// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TEST_ONLY_MARKER } from '../support/marker.ts';
import { scanBundle } from './fixture-bundle.ts';

const source = readFileSync(
  new URL('../journey/budgets-bundle-and-person-crossing.test.ts', import.meta.url),
  'utf8',
);
const credentials = ['ada', 'bea', 'noah', 'agent', 'external'].map((name) => {
  const value = new RegExp(`\\b${name}:\\s*\\{\\s*token:\\s*'([^']+)'`, 'u').exec(source)?.[1];
  if (value === undefined) throw new Error('journey crossing credential was not found');
  return [name, value] as const;
});

it.each(credentials)('the %s journey sign-in credential carries the test-only marker', (_name, value) => {
  expect(value.includes(TEST_ONLY_MARKER)).toBe(true);
});

it('a copied same-business journey credential is refused by the bundle scan', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'test-only-journey-credential-'));
  const bundle = join(scratch, 'dist');
  try {
    cpSync(join(import.meta.dirname, '../../apps/web/dist'), bundle, { recursive: true });
    const asset = readdirSync(join(bundle, 'assets')).find((file) => file.endsWith('.js'));
    if (asset === undefined) throw new Error('web build has no JavaScript asset');
    const credential = credentials.find(([name]) => name === 'noah')?.[1];
    if (credential === undefined) throw new Error('same-business credential was not found');
    appendFileSync(join(bundle, 'assets', asset), `\nconst planted = ${JSON.stringify(credential)};\n`);
    expect(scanBundle(bundle).some((hit) => hit.file === `assets/${asset}`)).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
