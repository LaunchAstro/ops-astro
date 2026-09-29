// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { openSide } from './capture.ts';
import { readPacket, rendererOf } from './packet.ts';
import { builtPages, report } from './report.ts';

describe('MP-1-7 pictures, session, renderer and board', () => {
  it('MP-1-7 nonexistent page pictures cannot satisfy the current-surfaces check', () => {
    const packet = readPacket();
    const shots = builtPages().flatMap((page) =>
      packet.widths.map((width) => ({
        page,
        width,
        picture: `/no-such-capture/${page}@${width}-light.png`,
        overflow: 0,
      })),
    );
    expect(report(packet, builtPages(), shots).failed).toBeGreaterThan(0);
  });

  it('MP-1-7 supplied state initialises the app session store', async () => {
    const addInitScript = vi.fn();
    const context = { route: vi.fn(), addInitScript };
    const browser = { newContext: vi.fn().mockResolvedValue(context) } as unknown as Browser;
    const dir = mkdtempSync(join(tmpdir(), 'sol-mp-1-7-'));
    const state = join(dir, 'state.json');
    writeFileSync(
      state,
      JSON.stringify({
        cookies: [],
        origins: [
          {
            origin: 'http://127.0.0.1:41234',
            localStorage: [
              {
                name: 'ops-astro.session',
                value: JSON.stringify({
                  token: 'synthetic-token',
                  businessKey: 'alpha',
                  email: 'a@example.invalid',
                }),
              },
            ],
          },
        ],
      }),
    );
    try {
      await openSide(browser, readPacket(), 390, {
        app: new URL('http://127.0.0.1:41234'),
        session: state,
      });
      expect(addInitScript).toHaveBeenCalled();
      expect(String(addInitScript.mock.calls[0]?.[0])).toContain('sessionStorage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MP-1-7 headed and new-headless Chromium have distinct renderer identities', () => {
    const pinned = readPacket().renderer;
    expect(rendererOf(pinned, { headless: false, channel: 'chromium' })).not.toEqual(
      rendererOf(pinned, { headless: true, channel: 'chromium' }),
    );
  });

  it('MP-1-7 the built board enters a pinned mockup comparison', () => {
    const catalogue = JSON.parse(readFileSync(new URL('states.json', import.meta.url), 'utf8')) as {
      states: { id: string; mockup: string | null; appPath?: string }[];
    };
    const board = catalogue.states.find((state) => state.id === 'board');
    expect(board?.mockup).toBe('/agency/projects/');
    expect(board?.appPath).toBe('/projects/');
  });
});
