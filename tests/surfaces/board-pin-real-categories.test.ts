// SPDX-License-Identifier: AGPL-3.0-only
// The board render pin draws the real categories, no database.
//
// The take retired SL07's made-up category seam (category-mock.ts), but the
// board render pin kept SL07's snapshot, which still draws the made-up
// categories (Ads, Content, Website) inside the mock label, so
// tests/surfaces/web-render-pins.test.tsx 'draws a task in every machine
// category and one with no state' is red at ba6dabe (it is red on 5b856ed too,
// green on 2190759).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SNAP = 'tests/surfaces/__snapshots__/web-render-pins.test.tsx.snap';

describe('the board render pin after the made-up category seam went', () => {
  it('the pinned board carries no retired mock category', () => {
    const pin = readFileSync(SNAP, 'utf8');
    expect(pin).not.toMatch(/data-add="category:(ads|content|website)"/u);
    expect(pin).not.toMatch(/data-provenance="mock"/u);
  });
});
