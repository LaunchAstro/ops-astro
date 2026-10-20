// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('escaped keyframes cannot hide the off-scale text they animate', async () => {
  const root = resolve(import.meta.dirname, '../..');
  const scratch = mkdtempSync(join(tmpdir(), 'census-keyframes-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const sheet = join(scratch, 'animated.css');
    const css = `.x {
      font: var(--type-body);
      letter-spacing: var(--type-body-tracking);
      text-transform: var(--type-body-case);
      animation: grow 1s -1s both paused;
    }
    @keyframes grow { to { font-size: 99px; font-weight: 900; letter-spacing: 9px; } }`;
    const census = (source: string) => {
      writeFileSync(sheet, source);
      return spawnSync(process.execPath, ['scripts/type-census.mjs', '--css', sheet], {
        cwd: root,
        encoding: 'utf8',
      });
    };
    expect(census(css).status).toBe(1);
    // A CSS identifier escape spells exactly the same at-rule name.
    const escaped = css.replace('@keyframes', '@key\\66rames');
    const page = await browser.newPage();
    const tokens = readFileSync(join(root, 'packages/ui/src/styles/1-tokens.css'), 'utf8');
    await page.setContent(`<style>${tokens}\n${escaped}</style><p class="x">Animated text</p>`);
    const applied = await page.locator('.x').evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.fontWeight, style.letterSpacing];
    });
    expect(applied).toEqual(['99px', '900', '9px']);
    const result = census(escaped);
    expect(
      result.status,
      `Chromium applies the animation but census passes: ${result.stdout}${result.stderr}`,
    ).toBe(1);
    expect(result.stderr).toContain('font-size: 99px');
  } finally {
    await browser.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
