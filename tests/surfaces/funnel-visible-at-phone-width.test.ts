// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

// The rest of the repository is read from the working directory, as the page-kit
// checks read it, so a copy of this check pointed at another sheet draws that sheet.
const repo = (path: string): string => join(process.cwd(), path);

/** A stage shape as drawn: its box, and whether it paints there. */
interface Drawn {
  readonly box: DOMRect;
  /**
   * Visible, every ancestor's opacity above zero, and the shape itself on top
   * at its own centre (hit-testing follows its clip-path), so a hidden,
   * transparent, covered or clipped-away shape does not paint.
   */
  readonly painted: boolean;
}

/**
 * The real funnel's stage shapes, drawn at 390 px in Chromium under the
 * package's sheets in load order, with `primitives` in the primitives sheet's place.
 */
async function stagesAt390(primitives: string): Promise<readonly Drawn[]> {
  const sheets = [
    ...readFileSync(repo('packages/ui/src/index.ts'), 'utf8').matchAll(
      /^import '\.\/(styles\/[\w-]+\.css)';$/gmu,
    ),
  ].map((match) =>
    match[1] === 'styles/2-primitives.css'
      ? primitives
      : readFileSync(repo(`packages/ui/src/${match[1] ?? ''}`), 'utf8'),
  );
  const { Funnel } = (await import(
    pathToFileURL(repo('packages/ui/src/kit/chart-inline.tsx')).href
  )) as typeof import('../../packages/ui/src/kit/chart-inline.tsx');
  const { launchChromium } = (await import(
    pathToFileURL(repo('tests/support/chromium.ts')).href
  )) as typeof import('../support/chromium.ts');
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
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.setContent(`<style>${sheets.join('\n')}</style>${html}`);
    return await page.locator('.funnel__bg').evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        let painted = getComputedStyle(node).visibility === 'visible';
        for (let at: Element | null = node; at !== null; at = at.parentElement) {
          const style = getComputedStyle(at);
          if (style.display === 'none' || Number(style.opacity) === 0) painted = false;
        }
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return {
          box: box.toJSON() as DOMRect,
          painted: painted && top !== null && node.contains(top),
        };
      }),
    );
  } finally {
    await browser.close();
  }
}

it('MP-1-5 the true-scale funnel remains visible at phone width', async () => {
  const css = readFileSync(`${root}packages/ui/src/styles/2-primitives.css`, 'utf8');
  const hidesShapeAtPhoneWidth =
    /@media\s*\(width\s*<=\s*640px\)[\s\S]*?\.funnel__shape\s*\{[^}]*display:\s*none/u.test(
      css,
    );
  expect(hidesShapeAtPhoneWidth).toBe(false);

  // Drawn: every stage's shape has area, sits inside a 390 px screen and paints.
  const stages = await stagesAt390(css);
  expect(stages).toHaveLength(2);
  for (const { box, painted } of stages) {
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.right).toBeLessThanOrEqual(390);
    expect(painted).toBe(true);
  }
}, 30_000);
