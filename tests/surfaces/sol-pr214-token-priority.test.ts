// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('Sol proof, criterion 1: an important light token cannot hide dark token drift', async () => {
  const original = readFileSync(`${root}packages/ui/src/styles/1-tokens.css`, 'utf8');
  const changed = original.replace('--ink: oklch(0 0 0);', '--ink: oklch(0 0 0) !important;');
  expect(changed).not.toBe(original);
  const directory = mkdtempSync(join(tmpdir(), 'sol-pr214-token-priority-'));
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent('<html data-theme="dark"><body>Dark text</body></html>');
    await page.addStyleTag({ content: original });
    const before = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
    );
    await page.addStyleTag({ content: changed });
    const after = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
    );
    expect(before).toBe('oklch(0.98 0 0)');
    expect(after).toBe('oklch(0 0 0)');
    const css = join(directory, 'tokens.css');
    writeFileSync(css, changed);
    const run = spawnSync(process.execPath, [`${root}scripts/token-diff.mjs`, '--css', css], {
      encoding: 'utf8',
    });
    expect(
      run.status,
      `Browser dark ink changed from ${before} to ${after}. ${run.stdout}${run.stderr}`,
    ).toBe(1);
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
