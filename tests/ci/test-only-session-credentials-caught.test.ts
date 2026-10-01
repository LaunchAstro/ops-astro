// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TEST_ONLY_MARKER } from '../support/marker.ts';
import { scanBundle } from './fixture-bundle.ts';

const source = readFileSync(new URL('../api/session-cookie.test.ts', import.meta.url), 'utf8');
const password = /password:\s*'([^']+)'/u.exec(source)?.[1];
const accessToken = /const tokens = \['([^']+)'/u.exec(source)?.[1];
if (password === undefined || accessToken === undefined) {
  throw new Error('session-cookie sign-in values were not found');
}

function caughtInBundle(value: string): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'test-only-session-value-'));
  const bundle = join(scratch, 'dist');
  try {
    cpSync(join(import.meta.dirname, '../../apps/web/dist'), bundle, { recursive: true });
    const asset = readdirSync(join(bundle, 'assets')).find((file) => file.endsWith('.js'));
    if (asset === undefined) throw new Error('web build has no JavaScript asset');
    appendFileSync(join(bundle, 'assets', asset), `\nconst planted = ${JSON.stringify(value)};\n`);
    return scanBundle(bundle).some((hit) => hit.file === `assets/${asset}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

it.each([
  ['sign-in password', password],
  ['mock access token', accessToken],
])('the session-cookie %s carries the test-only marker', (_name, value) => {
  expect(value.includes(TEST_ONLY_MARKER)).toBe(true);
});

it.each([
  ['sign-in password', password],
  ['mock access token', accessToken],
])('a copied session-cookie %s is refused by the bundle scan', (_name, value) => {
  expect(caughtInBundle(value)).toBe(true);
});
