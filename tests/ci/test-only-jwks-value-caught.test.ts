// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { KEY_SET_URL } from '../api/jwks.fixture.ts';
import { TEST_ONLY_MARKER } from '../support/marker.ts';
import { scanBundle } from './fixture-bundle.ts';

it('every verifier fixture key-set address carries the test-only marker', () => {
  expect(KEY_SET_URL.toLowerCase().includes(TEST_ONLY_MARKER.toLowerCase())).toBe(true);
});

it('a verifier fixture key-set address copied into the web bundle is refused', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'test-only-jwks-value-'));
  const bundle = join(scratch, 'dist');
  try {
    cpSync(join(import.meta.dirname, '../../apps/web/dist'), bundle, { recursive: true });
    const asset = readdirSync(join(bundle, 'assets')).find((file) => file.endsWith('.js'));
    if (asset === undefined) throw new Error('web build has no JavaScript asset');
    appendFileSync(join(bundle, 'assets', asset), `\nconst planted = ${JSON.stringify(KEY_SET_URL)};\n`);
    expect(scanBundle(bundle).some((hit) => hit.file === `assets/${asset}`)).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
