// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X, LF-2: a hello covers the page that sent it. When the live frame loads
// another page (a link, a script, a redirect), the view hides it and waits for
// a hello for a fresh nonce; a page without the embed falls back. From the
// security review of 4b727fb.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SITE,
  frameAt,
  open,
  phasesSeen,
  startWorld,
  stopWorld,
  tracePhases,
} from './c35-x-live-view-world.ts';

beforeAll(startWorld);
afterAll(stopWorld);

describe('C35-X a live frame that loads another page is checked again', () => {
  it('a frame that navigates away from the embed is hidden, then falls back', async () => {
    const watched = await open({ page: `${SITE}/embed-then-away` });
    try {
      await tracePhases(watched.page);
      await watched.page.waitForSelector('[data-live-view="fallback"]', { timeout: 6000 });
      expect(await phasesSeen(watched.page)).toEqual(['live', 'waiting', 'fallback']);
      expect(await watched.page.locator('iframe').count()).toBe(0);
    } finally {
      await watched.context.close();
    }
  }, 30_000);

  it('a frame that loads another page with the embed says hello again for a fresh nonce', async () => {
    const watched = await open({ page: `${SITE}/embed-then-embed` });
    try {
      await tracePhases(watched.page);
      await expect
        .poll(async () => await phasesSeen(watched.page), { timeout: 6000 })
        .toEqual(['live', 'waiting', 'live']);
      const nonce = await frameAt(watched.page, '/embed').evaluate(
        () => document.body.dataset['nonce'],
      );
      expect(nonce).toMatch(/^[\w-]{43}$/u);
      await watched.page.waitForTimeout(1000);
      expect(await phasesSeen(watched.page)).toEqual(['live', 'waiting', 'live']);
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X a live frame that stops answering or changes revision is checked again', () => {
  it('a frame that moves to a page that never finishes loading is hidden, then falls back', async () => {
    const watched = await open({ page: `${SITE}/embed-then-endless` });
    try {
      await tracePhases(watched.page);
      await watched.page.waitForSelector('[data-live-view="fallback"]', { timeout: 7000 });
      expect(await phasesSeen(watched.page)).toEqual(['live', 'waiting', 'fallback']);
    } finally {
      await watched.context.close();
    }
  }, 30_000);

  it('switching back to a revision is a new load that waits for its own hello', async () => {
    const watched = await open({ page: `${SITE}/embed` });
    try {
      await watched.page.waitForSelector('[data-live-view="live"]', { timeout: 3000 });
      // Both switches in one task, React's render flushed between them by a
      // microtask, so no hello (a message event, a later task) can land between.
      const after = await watched.page.evaluate(async () => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, alone
        const view = (): Record<string, unknown> => ({
          phase: document.querySelector<HTMLElement>('[data-live-view]')?.dataset['liveView'],
          hidden: document.querySelector<HTMLElement>('[data-live-frame]')?.hidden,
          revision: document.querySelector('iframe[data-live-frame]') === null ? 'none' : 'framed',
        });
        document.querySelector<HTMLElement>('[data-next-revision]')?.click();
        await Promise.resolve();
        const between = view();
        document.querySelector<HTMLElement>('[data-previous-revision]')?.click();
        await Promise.resolve();
        return { between, back: view() };
      });
      expect(after.between).toEqual({ phase: 'waiting', hidden: true, revision: 'framed' });
      expect(after.back).toEqual({ phase: 'waiting', hidden: true, revision: 'framed' });
      await watched.page.waitForSelector('[data-live-view="live"]', { timeout: 3000 });
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});
