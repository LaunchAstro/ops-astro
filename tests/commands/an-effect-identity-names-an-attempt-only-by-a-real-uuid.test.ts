// SPDX-License-Identifier: AGPL-3.0-only
//
// An effect's operation identity is `effect:` and its attempt's uuid. The
// parser hands the suffix to a uuid parameter (`task.comment`'s effect check),
// so a suffix that is 36 characters of hexadecimal digits and hyphens but not
// a uuid would reach the database and be raised on there. It names no attempt,
// so the parser answers `undefined` for it, as it does for any other identity.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  effectAttemptOf,
  effectOperationId,
} from '../../packages/core-wire/src/effect-identity.ts';

describe('an effect identity names an attempt only by a real uuid', () => {
  it('reads back the attempt it was made from', () => {
    const attempt = randomUUID();
    expect(effectAttemptOf(effectOperationId(attempt))).toBe(attempt);
  });

  it.each([
    ['36 hyphens', '-'.repeat(36)],
    ['36 hexadecimal digits with no hyphen', 'a'.repeat(36)],
    ['hyphens in the wrong places', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa-'],
    ['a uuid with its hyphens moved', '0123456-89ab-cdef-0123-456789abcdef0'],
  ])('refuses %s as an attempt id', (_, suffix) => {
    expect(suffix).toHaveLength(36);
    expect(effectAttemptOf(`effect:${suffix}`)).toBeUndefined();
  });

  it('refuses an identity that is not an effect at all', () => {
    expect(effectAttemptOf(randomUUID())).toBeUndefined();
    expect(effectAttemptOf(`effect:${randomUUID()}x`)).toBeUndefined();
  });
});
