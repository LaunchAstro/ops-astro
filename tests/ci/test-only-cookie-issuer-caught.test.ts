// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ISSUER } from '../api/session-cookie.fixture.ts';
import { TEST_ONLY_MARKER } from '../support/marker.ts';
import { scanBundle } from './fixture-bundle.ts';

it('the active session-cookie sign-in issuer carries the test-only marker', () => {
  expect(ISSUER.toLowerCase().includes(TEST_ONLY_MARKER.toLowerCase())).toBe(true);
});

it('a session-cookie sign-in issuer copied into the web bundle is refused', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'test-only-cookie-issuer-'));
  const bundle = join(scratch, 'dist');
  try {
    cpSync(join(import.meta.dirname, '../../apps/web/dist'), bundle, { recursive: true });
    const asset = readdirSync(join(bundle, 'assets')).find((file) => file.endsWith('.js'));
    if (asset === undefined) throw new Error('web build has no JavaScript asset');
    appendFileSync(join(bundle, 'assets', asset), `\nconst planted = ${JSON.stringify(ISSUER)};\n`);
    expect(scanBundle(bundle).some((hit) => hit.file === `assets/${asset}`)).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
