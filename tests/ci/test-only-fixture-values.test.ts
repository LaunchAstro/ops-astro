// SPDX-License-Identifier: AGPL-3.0-only
//
// Scanner option A, round 3 (REVB1SL01A2): a fixture that exports a sign-in
// value (an issuer, key id, key-set address, secret, password, token or API
// key) makes it from TEST_ONLY_MARKER at run time, so the bundle scanner
// catches any copy. A plain string literal under such a name is refused here.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const TESTS = join(import.meta.dirname, '..');
const SIGN_IN_EXPORT =
  /export const (\w*(?:ISSUER|KEY_SET|KID|SECRET|PASSWORD|TOKEN|API_KEY)\w*)[^=\n]*=\s*(?:'|"|`[^`$]*`)/giu;

function unmarked(source: string): string[] {
  return [...source.matchAll(SIGN_IN_EXPORT)].map((match) => match[1] ?? '');
}

it('refuses a sign-in export made from a plain literal, and passes one made from the marker', () => {
  expect(unmarked("export const ISSUER = 'http://127.0.0.1:1';")).toStrictEqual(['ISSUER']);
  expect(unmarked('export const TEST_KID: string = `kid-1`;')).toStrictEqual(['TEST_KID']);
  expect(unmarked('export const ISSUER: string = `https://${made()}.example.test`;')).toStrictEqual(
    [],
  );
});

it('no fixture or support file exports an unmarked sign-in value', () => {
  const files = readdirSync(TESTS, { recursive: true, encoding: 'utf8' }).filter((file) =>
    /\.fixture\.ts$|^support\/[^/]+\.ts$|^(api\/fixture|acceptance\/cast)\.ts$/u.test(file),
  );
  const found = files.flatMap((file) =>
    unmarked(readFileSync(join(TESTS, file), 'utf8')).map((name) => `${file}: ${name}`),
  );
  expect(files.length).toBeGreaterThan(30);
  expect(found).toStrictEqual([]);
});
