// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Funnel } from '../../packages/ui/src/kit/chart-inline.tsx';
import { launchChromium } from '../support/chromium.ts';

// Sol OW-125 criterion 7, retitled by what it proves; its body is Sol's.
it('the phone-width funnel check rejects a collapsed drawing', async () => {
  const root = process.cwd();
  const css = readFileSync(join(root, 'packages/ui/src/styles/2-primitives.css'), 'utf8');
  const start = css.indexOf('@media (width <= 640px) {', css.indexOf('/* At phone width a stage'));
  const end = css.indexOf('/* -- The component gallery page', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const mutant = css.slice(0, start) + css.slice(end);
  const tokens = readFileSync(join(root, 'packages/ui/src/styles/1-tokens.css'), 'utf8');
  const html = renderToStaticMarkup(
    createElement(Funnel, {
      name: 'Search to booking',
      steps: [
        { label: 'Enquiries', count: 400 },
        { label: 'Qualified', count: 180 },
      ],
    }),
  );
  const browser = await launchChromium();
  const scratch = mkdtempSync(join(root, 'tests/surfaces/sol-ow125-mutant-'));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    const widths = async (sheet: string) => {
      await page.setContent(`<style>${tokens}\n${sheet}</style>${html}`);
      return page
        .locator('.funnel__bg')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    };
    expect((await widths(css)).every((width) => width > 0)).toBe(true);
    expect(await widths(mutant)).toEqual([0, 0]);
    const mutantPath = join(scratch, 'mutant.css');
    writeFileSync(mutantPath, mutant);
    const original = readFileSync(
      join(root, 'tests/surfaces/funnel-visible-at-phone-width.test.ts'),
      'utf8',
    );
    const redirected = original.replace(
      '`${root}packages/ui/src/styles/2-primitives.css`',
      JSON.stringify(mutantPath),
    );
    expect(redirected).not.toBe(original);
    const testPath = join(scratch, 'original-check.test.ts');
    writeFileSync(testPath, redirected);
    const configPath = join(scratch, 'vitest.config.mjs');
    writeFileSync(configPath, 'export default { test: { environment: "node" } };');
    const checked = spawnSync(
      'corepack',
      ['pnpm', 'exec', 'vitest', 'run', '--reporter', 'verbose', '--config', configPath, testPath],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, TMPDIR: scratch },
      },
    );
    expect(checked.error).toBeUndefined();
    expect(checked.stdout).toContain('MP-1-5 the true-scale funnel remains visible at phone width');
    expect(
      checked.status,
      'the claimed visibility proof must fail when both drawn stages have zero width',
    ).not.toBe(0);
  } finally {
    await browser.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);
