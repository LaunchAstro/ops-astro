// SPDX-License-Identifier: AGPL-3.0-only
//
// Scanner option A (REVB1SL01A2, REVB1SL01A3): a fixture that exports a sign-in
// value (an issuer, key id, key-set address, secret, password, token or API
// key) makes it from TEST_ONLY_MARKER, so the bundle scanner catches any copy.
// Every fixture and support module is imported and each such export is judged
// by its value, however it was made.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TEST_ONLY_MARKER } from '../support/marker.ts';

const TESTS = join(import.meta.dirname, '..');
const SIGN_IN_NAME = /ISSUER|KEY_SET|KID|SECRET|PASSWORD|TOKEN|API_KEY/iu;

function unmarked(exports: Record<string, unknown>): string[] {
  return Object.entries(exports)
    .filter(([name, value]) => SIGN_IN_NAME.test(name) && typeof value === 'string')
    .filter(([, value]) => !(value as string).includes(TEST_ONLY_MARKER))
    .map(([name]) => name);
}

// A process a test spawns, not a fixture: it exits at import. Its exports are park points.
const SPAWNED = 'support/parking-worker.ts';
const files = readdirSync(TESTS, { recursive: true, encoding: 'utf8' }).filter(
  (file) =>
    /\.fixture\.ts$|^support\/[^/]+\.ts$|^(api\/fixture|acceptance\/cast)\.ts$/u.test(file) &&
    !file.endsWith('.test.ts') &&
    file !== SPAWNED &&
    SIGN_IN_NAME.test(readFileSync(join(TESTS, file), 'utf8')),
);
// At collection, so a fixture's own afterAll registers on this file.
const modules = await Promise.all(
  files.map(
    async (file) => [file, (await import(join(TESTS, file))) as Record<string, unknown>] as const,
  ),
);

it('refuses an unmarked sign-in export, computed or literal, and passes a marked one', () => {
  const computed = ['synthetic', 'issuer'].join('-');
  expect(
    unmarked({ ISSUER: computed, TEST_KID: `${TEST_ONLY_MARKER}-1`, NAME: 'x' }),
  ).toStrictEqual(['ISSUER']);
});

it('no fixture or support module exports an unmarked sign-in value', () => {
  expect(files).toContain('support/sign-in.ts');
  expect(modules.length).toBeGreaterThan(10);
  expect(
    modules.flatMap(([file, exports]) => unmarked(exports).map((name) => `${file}: ${name}`)),
  ).toStrictEqual([]);
});
