// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Term } from '../../packages/ui/src/kit/marks.tsx';
import { launchChromium } from '../support/chromium.ts';

// Sol G2-FIX2 criterion 7, retitled by what it proves; its body is Sol's.
it('the page-kit check rejects a class-attribute tooltip restyle', async () => {
  const root = process.cwd();
  const source = join(root, 'packages/ui/src');
  const scratch = mkdtempSync(join(tmpdir(), 'sol-g2-fix2-class-attribute-'));
  const browser = await launchChromium();
  try {
    const mutation = '.sol-host [class~="term__tip"] { visibility: hidden; }';
    const page = await browser.newPage();
    await page.setContent(`<style>${readFileSync(join(source, 'styles/1-tokens.css'), 'utf8')}
      ${readFileSync(join(source, 'styles/2-controls-and-marks.css'), 'utf8')}</style>
      <section class="sol-host">${renderToStaticMarkup(<Term tip="Explanation">Word</Term>)}</section>`);
    await page.keyboard.press('Tab');
    expect(
      await page.locator('.term').evaluate((element) => element.matches(':focus-visible')),
    ).toBe(true);
    expect(await page.locator('.term__tip').isVisible()).toBe(true);
    await page.addStyleTag({ content: mutation });
    expect(await page.locator('.term__tip').isVisible()).toBe(false);

    // Run the original named suite, unchanged, against disposable stylesheet copies.
    mkdirSync(join(scratch, 'packages/ui/src'), { recursive: true });
    cpSync(join(source, 'styles'), join(scratch, 'packages/ui/src/styles'), { recursive: true });
    cpSync(join(source, 'index.ts'), join(scratch, 'packages/ui/src/index.ts'));
    cpSync(
      join(root, 'tests/surfaces/mp-9-1-page-kit-styles.test.ts'),
      join(scratch, 'named.test.ts'),
    );
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    writeFileSync(join(scratch, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(scratch, 'vitest.config.mjs'),
      'export default { test: { environment: "node", include: ["named.test.ts"] } };',
    );
    const sheet = join(scratch, 'packages/ui/src/styles/7-page-kit.css');
    const original = readFileSync(sheet, 'utf8');
    const run = () =>
      spawnSync(
        process.execPath,
        [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.mjs'],
        {
          cwd: scratch,
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, TMPDIR: scratch, NODE_DISABLE_COMPILE_CACHE: '1' },
        },
      );
    const baseline = run();
    expect(baseline.status, baseline.stdout + baseline.stderr).toBe(0);
    // Positive control: the guard does reject the same declaration without a parent.
    writeFileSync(sheet, original + '\n.term__tip { visibility: hidden; }\n');
    const direct = run();
    expect(direct.status, direct.stdout + direct.stderr).toBe(1);
    expect(direct.stdout + direct.stderr).toContain(
      'the page kit stylesheet styles no kit primitive',
    );
    writeFileSync(sheet, original + '\n' + mutation + '\n');
    const scoped = run();
    expect(
      scoped.status,
      'A page-kit rule hides the focused kit tooltip, but the unchanged named suite stays green.\n' +
        scoped.stdout +
        scoped.stderr,
    ).toBe(1);
  } finally {
    await browser.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
