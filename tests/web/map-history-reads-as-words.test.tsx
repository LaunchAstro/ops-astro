// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The map's history says when each version was written as a person reads a
// time, on the business's clock, and never shows the writer's internal id:
// the map read carries only that id, so the row says "someone" instead.

import { afterEach, describe, expect, it } from 'vitest';
import type { Mounted } from '../surfaces/mount.tsx';
import { WRITER_ID, WRITTEN_AT, openMadeUpMap } from './one-made-up-map.tsx';

const open: Mounted[] = [];

afterEach(async () => {
  for (const page of open.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop
    await page.unmount();
  }
});

describe('the map history', () => {
  it('shows a readable time and no internal id for who wrote each version', async () => {
    const page = await openMadeUpMap(open);
    const row = page.find('[data-version="2"]')?.textContent ?? '';
    expect(row).toMatch(/13 Oct 2026, 12:36/u);
    expect(row).toContain('someone');
    expect(row).not.toContain(WRITTEN_AT);
    expect(page.find('[data-map-section="history"]')?.textContent).not.toContain(WRITER_ID);
  });
});
