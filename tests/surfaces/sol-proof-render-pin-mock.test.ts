// Sol proof (interim Opus review of b0/SL08 2190759..ba6dabe), no database.
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

describe('Sol proof, criterion correctness: the board render pin after the mock seam went', () => {
  it('Sol proof, criterion correctness: the pinned board carries no retired mock category', () => {
    const pin = readFileSync(SNAP, 'utf8');
    expect(pin).not.toMatch(/data-add="category:(ads|content|website)"/u);
    expect(pin).not.toMatch(/data-provenance="mock"/u);
  });
});
