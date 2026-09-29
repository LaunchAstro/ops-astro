// SPDX-License-Identifier: AGPL-3.0-only
//
// The batch 1 route rehearsal. This case fails on purpose in its first
// candidate, so the batch pull request must go red; the corrected candidate
// makes it pass. Neither ever merges to main.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../../docs/rehearsal/batch-1.md', import.meta.url), 'utf8');

describe('the batch 1 rehearsal note', () => {
  it('says it never merges', () => {
    expect(doc).toContain('This file never merges.');
  });
});
