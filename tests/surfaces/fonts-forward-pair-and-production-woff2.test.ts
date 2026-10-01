// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, unicorn/consistent-function-scoping, unicorn/prefer-string-replace-all
   -- the proof's body is kept as reviewed, byte for byte. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../support/chromium.ts';
import { build, preview } from 'vite';
import { expect, it } from 'vitest';

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
const anchor = '7bda387397357209f686709c7a94b297c10fcd9b';
const testPath = 'tests/surfaces/mp-1-2-fonts-icons-brand.test.tsx';
const cssPath = 'packages/ui/src/styles/0-fonts.css';
const fontFile = 'funnel-sans-latin-wght-normal.woff2';
const bundledFont = /\/funnel-sans-latin-wght-normal-[^/]+\.woff2(?:\?|$)/u;
const variableFace = /@font-face\s*\{\s*font-family:\s*'Funnel Sans';[\s\S]*?\n\}/u;

it('MP-1-2 a forward red then green pair and a production woff2 request', async () => {
  const head = process.env['SOL_REVIEW_HEAD'] ?? 'HEAD';
  const commits = git('rev-list', '--reverse', '--ancestry-path', `${anchor}..${head}`)
    .split('\n')
    .filter(Boolean);
  let red: string | undefined;
  let green: string | undefined;
  for (const commit of commits) {
    const test = git('show', `${commit}:${testPath}`);
    const css = git('show', `${commit}:${cssPath}`);
    const expectsVariable = test.includes(fontFile) && test.includes('expect(face).toContain');
    const hasVariableFace =
      variableFace.test(css) && css.includes(`@fontsource-variable/funnel-sans/files/${fontFile}`);
    if (red === undefined && expectsVariable && !hasVariableFace) red = commit;
    else if (red !== undefined && expectsVariable && hasVariableFace) {
      green = commit;
      break;
    }
  }
  expect(
    red,
    'a later committed revision must leave the named test red without the face',
  ).toBeDefined();
  expect(green, 'a subsequent committed revision must restore the face').toBeDefined();
  if (red === undefined || green === undefined)
    throw new Error('forward red and green commits required');
  expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', red)).toBe(cssPath);
  expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', green)).toBe(cssPath);
  const beforeRed = git('show', `${red}^:${cssPath}`);
  const atRed = git('show', `${red}:${cssPath}`);
  expect(
    beforeRed.match(variableFace),
    'the red commit removes the existing Funnel Sans face',
  ).not.toBeNull();
  const normalise = (css: string): string => css.replace(/\n{3,}/gu, '\n\n').trim();
  expect(normalise(atRed), 'the red commit changes only the Funnel Sans face').toBe(
    normalise(beforeRed.replace(variableFace, '')),
  );
  expect(normalise(git('show', `${green}:${cssPath}`)), 'the green commit restores the face').toBe(
    normalise(beforeRed),
  );

  const configFile = fileURLToPath(new URL('../../apps/web/vite.config.ts', import.meta.url));
  await build({ configFile, logLevel: 'silent' });
  const server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  try {
    const address = server.httpServer.address();
    if (address === null || typeof address === 'string')
      throw new Error('Vite preview has no TCP port');
    const browser = await launchChromium();
    try {
      const page = await browser.newPage();
      const fontResponse = page.waitForResponse(
        (response) =>
          response.request().resourceType() === 'font' && bundledFont.test(response.url()),
      );
      await page.goto(`http://127.0.0.1:${String(address.port)}/`, { waitUntil: 'load' });
      const loaded = await page.evaluate(async () => {
        await document.fonts.load('400 16px "Funnel Sans"');
        return [...document.fonts].some(
          (face) => face.family.replaceAll('"', '') === 'Funnel Sans' && face.status === 'loaded',
        );
      });
      const response = await fontResponse;
      expect(loaded, 'the app loads Funnel Sans without a harness-injected face').toBe(true);
      expect(response.status(), 'the production font request succeeds').toBe(200);
      const installed = readFileSync(
        fileURLToPath(
          new URL(
            `../../packages/ui/node_modules/@fontsource-variable/funnel-sans/files/${fontFile}`,
            import.meta.url,
          ),
        ),
      );
      expect(await response.body(), 'the requested bytes are the licensed variable woff2').toEqual(
        installed,
      );
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}, 120_000);
