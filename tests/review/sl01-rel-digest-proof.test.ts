// SPDX-License-Identifier: AGPL-3.0-only
// Narrow re-check proof: promotion compares the exact stamped output bytes.

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { outputDigest } from '../../scripts/ops/release.ts';

const out = mkdtempSync(join(tmpdir(), 'sl01-rel-digest-proof-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

it('REL digest detects a byte change in build.json outside its digest field', () => {
  writeFileSync(join(out, 'config.json'), '{"version":3}');
  writeFileSync(join(out, 'build.json'), '{"build":"abcdef012345","digest":"sha256:recorded"}');
  const before = outputDigest(out);
  appendFileSync(join(out, 'build.json'), '\n');
  expect(outputDigest(out)).not.toBe(before);
});
