// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fetchAssets, readAssets } from './packet.ts';

describe('criterion 2', () => {
  it('a changed asset record cannot fetch before its pin is checked', async () => {
    const manifest = structuredClone(readAssets());
    const font = manifest.assets.find((asset) => asset.kind === 'font');
    if (font === undefined) throw new Error('the test needs a font record');
    font.file = `fonts/sol-proof-${randomUUID()}.ttf`;
    font.url = 'https://example.invalid/sol-proof.ttf';

    const fetchSpy = vi.fn(() => Promise.reject(new Error('an unpinned URL was fetched')));
    vi.stubGlobal('fetch', fetchSpy);
    let failure: unknown;
    try {
      await fetchAssets(manifest);
    } catch (error) {
      failure = error;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(failure)).toMatch(/asset records/u);
  });
});
