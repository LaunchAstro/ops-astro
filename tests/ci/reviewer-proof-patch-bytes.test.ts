// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('the committed scanner proof retains the reviewer patch bytes', () => {
  const proof = readFileSync(
    new URL('./shared-stem-sign-in-value-caught.test.ts', import.meta.url),
  );
  expect(createHash('sha256').update(proof).digest('hex')).toBe(
    'eccad607cbd28374c18a3f0e7405150f681161a06ee8d4d7e08dcb409e80e79b',
  );
});
