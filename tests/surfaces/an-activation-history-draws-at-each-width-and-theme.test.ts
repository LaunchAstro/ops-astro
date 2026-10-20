// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers on the width-and-theme harness (MP-1-7): the
// weekly report's row opens its history, drawn from the made-up
// `automation.history` answer, in light and dark at 1480, 900 and 390 in the
// pinned headless shell. Each drawing is the app's own page, with no sideways
// scroll, its outcomes worded, built from the shared kit's table, chips and
// buttons with no private style, and dark draws differently from light. No
// browser, no capture: the launch fails the test, never skips it.

import { describe, expect, it } from 'vitest';
import type { CapabilitiesResult } from '../../packages/core-wire/src/index.ts';
import { answer, eachBuiltPage, screenOf, withSignedInApp } from '../visual/app-pages.ts';
import { comparePng } from '../visual/compare.ts';
import { scrollMetrics } from '../visual/drift.ts';
import { answerMadeUp, madeUpAnswer } from '../visual/made-up-api.ts';
import { themesOf } from '../visual/packet.ts';
import { overflowOf } from '../visual/report.ts';

const WIDTHS = [1480, 900, 390];
const PAGE = 'agency:settings';
const ROW = '[data-activation="a-weekly"]';
const HISTORY = '[data-history="a-weekly"]';

/** The made-up session's grants, with `settings:read`, so Settings draws Workflow triggers. */
function capabilities(): CapabilitiesResult {
  const made = madeUpAnswer('/api/b/alpha/session/capabilities');
  const base = (made !== undefined && 'json' in made ? made.json : {}) as CapabilitiesResult;
  return { ...base, grants: [...base.grants, { collection: 'settings', action: 'read' }] };
}

interface Drawn {
  readonly width: number;
  readonly theme: string;
  readonly screen: string;
  readonly overflow: number;
  readonly text: string;
  readonly kit: readonly number[];
  readonly png: Buffer;
}

async function drawEverywhere(): Promise<Drawn[]> {
  return await withSignedInApp(async ({ browser, packet, app, session }) => {
    const themes = themesOf(packet);
    expect(themes).toContain('dark');
    return await eachBuiltPage(
      {
        browser,
        packet,
        app,
        session,
        widths: WIDTHS,
        themes,
        pages: [PAGE],
        route: async ({ signedIn }) => {
          await answerMadeUp(signedIn.context);
          await answer(signedIn, { 'session/capabilities': capabilities() });
        },
      },
      async ({ width, theme, page }) => {
        await page.locator(`${ROW} [data-control="history"]`).click();
        const history = page.locator(HISTORY);
        await history.locator('tbody tr').first().waitFor({ timeout: 10_000 });
        await history.scrollIntoViewIfNeeded();
        const kit = await history.evaluate((node) => [
          node.querySelectorAll('table.table').length,
          node.querySelectorAll('.chip').length,
          node.querySelectorAll('.btn').length,
          node.querySelectorAll('[style]').length,
        ]);
        return {
          width,
          theme,
          screen: await page.evaluate(screenOf),
          overflow: overflowOf(await page.evaluate(scrollMetrics)),
          text: (await history.textContent()) ?? '',
          kit,
          png: await history.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' }),
        };
      },
    );
  });
}

describe('an activation history on the width-and-theme harness', () => {
  it('draws the history from its row in light and dark at 1480, 900 and 390, from the shared kit with no sideways scroll', async () => {
    const drawn = await drawEverywhere();
    expect(drawn).toHaveLength(WIDTHS.length * 2);
    for (const one of drawn) {
      const name = `${PAGE}@${String(one.width)}-${one.theme}`;
      expect(one.screen, name).toBe('the page');
      expect(one.overflow, name).toBe(0);
      expect(one.text, name).toContain('Not approved for this version');
      expect(one.text, name).toContain('Revoked the approval');
      expect(one.text, name).toContain('Nathan');
      // One kit table, a chip per occurrence, the older-entries button, no inline style.
      expect(one.kit, name).toStrictEqual([1, 3, 1, 0]);
    }
    for (const width of WIDTHS) {
      const light = drawn.find((one) => one.width === width && one.theme === 'light');
      const dark = drawn.find((one) => one.width === width && one.theme === 'dark');
      const same = comparePng(
        `${PAGE}@${String(width)}`,
        light?.png ?? Buffer.alloc(0),
        dark?.png ?? Buffer.alloc(0),
      );
      expect(same.pass, `${PAGE}@${String(width)} dark draws the same as light`).toBe(false);
    }
  }, 600_000);
});
