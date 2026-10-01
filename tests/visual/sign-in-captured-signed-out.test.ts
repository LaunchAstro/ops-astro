// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { expect, it, vi } from 'vitest';
import { captureBuiltPages } from './app-pages.ts';
import { readPacket } from './packet.ts';

const sessions = vi.hoisted(() => new Map<string, boolean>());

vi.mock('./capture.ts', () => ({
  openSide: (
    _browser: unknown,
    _packet: unknown,
    width: number,
    source: { session?: string; colorScheme: string },
  ) => ({
    session: source.session,
    width,
    theme: source.colorScheme,
    // The made-up answers route on the signed-in context; nothing is fetched here.
    context: { close: () => {}, route: async () => {} },
  }),
  load: (
    side: { session?: string; width: number; theme: string },
    _packet: unknown,
    url: string,
  ) => {
    const path = new URL(url).pathname;
    sessions.set(`${path}@${side.width}-${side.theme}`, side.session !== undefined);
    return {
      evaluate: () => ({ scrollWidth: 390, clientWidth: 390 }),
      close: () => {},
    };
  },
  shoot: () => [{ png: Buffer.from('capture stub') }],
}));

it('MP-1-1 the sign-in page is captured signed out', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sol-pr155-sign-in-'));
  sessions.clear();
  try {
    await captureBuiltPages({
      browser: {} as Browser,
      packet: readPacket(),
      app: new URL('http://127.0.0.1:5391'),
      session: 'made-up-session.json',
      widths: [1480, 900, 390],
      themes: ['light', 'dark'],
      out,
    });
    for (const width of [1480, 900, 390])
      for (const theme of ['light', 'dark']) {
        expect(
          sessions.get(`/sign-in@${width}-${theme}`),
          `the sign-in form needs a signed-out context at ${width}-${theme}`,
        ).toBe(false);
        expect(
          sessions.get(`/gallery/@${width}-${theme}`),
          `the gallery needs a signed-in context at ${width}-${theme}`,
        ).toBe(true);
      }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
