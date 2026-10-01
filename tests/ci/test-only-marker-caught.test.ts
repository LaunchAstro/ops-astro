// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's option A for the bundle scanner: every test sign-in value is the
// one marker plus random bytes made at run time, and a built file carrying the
// marker, whole and in any case, is refused. A clean bundle, the app's own
// `sign-in` word and words that merely contain it included, passes.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_ONLY_MARKER } from '../support/marker.ts';
import { TEST_KEY_SET_URL, TEST_KID } from '../support/sign-in.ts';
import { scanBundle } from './fixture-bundle.ts';

/** A repository whose test-only sign-in module shares its stem with a shipped one, and a bundle. */
function scanned(asset: string) {
  const root = mkdtempSync(join(tmpdir(), 'test-only-marker-'));
  const dist = join(root, 'apps/web/dist');
  try {
    for (const file of ['tests/support/sign-in.ts', 'apps/web/src/session/sign-in.ts']) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), 'export {};\n');
    }
    mkdirSync(join(root, 'tests/fixture'), { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'asset.js'), asset);
    return scanBundle(dist, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('S0-6 no test sign-in value in the bundle, by one marker', () => {
  it('makes every test sign-in value at run time from the marker and random bytes', () => {
    for (const value of [TEST_KID, TEST_KEY_SET_URL]) {
      expect(value).toMatch(new RegExp(`${TEST_ONLY_MARKER}-[0-9a-f]{12}\\b`, 'u'));
    }
  });

  it('refuses a built file carrying the marker, whole in any case, naming the file', () => {
    for (const value of [TEST_KID, TEST_KID.toUpperCase(), TEST_ONLY_MARKER]) {
      expect(scanned(`const kid = "${value}";\n`), value).toContainEqual({
        file: 'asset.js',
        selector: TEST_ONLY_MARKER,
      });
    }
  });

  it('passes a clean bundle: the app says sign-in, and words that contain it', () => {
    const clean = 'const a = "sign-in", b = "assign-incoming", c = "/api/sign-in";\n';
    expect(scanned(clean)).toStrictEqual([]);
  });
});
