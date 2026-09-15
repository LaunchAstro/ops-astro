// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

// The placeholder test.
//
// It exists so the test runner is wired, blocking and green from commit one,
// rather than added later when there is pressure not to. It asserts nothing
// about the product, because there is no product.
//
// The first real test replaces it. Until then, a green run here means the
// runner works, and nothing more.

describe('the test runner', () => {
  it('runs', () => {
    expect(true).toBe(true);
  });

  it('does not claim anything is built', () => {
    const built: readonly string[] = [];
    expect(built).toHaveLength(0);
  });
});
