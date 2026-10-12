// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, unicorn/consistent-function-scoping, unicorn/prefer-string-replace-all
   -- the proof's body is kept as reviewed, but for where it builds and the
   walk over every path into head below. */
//
// It builds into a directory of its own, never apps/web/dist: under `pnpm
// check` other tests copy that bundle in workers beside this one, and a
// rebuild there empties it under them.
//
// Every commit after the anchor that changes the Funnel Sans face (its block
// in the font sheet, or the pinned package its WOFF2 comes from) must be one
// half of a forward red then green pair, on whatever path it reaches head: a
// side branch forked before the anchor and merged later included.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../support/chromium.ts';
import { build, preview } from 'vite';
import { afterAll, expect, it } from 'vitest';

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
const anchor = '7bda387397357209f686709c7a94b297c10fcd9b';
const testPath = 'tests/surfaces/mp-1-2-fonts-icons-brand.test.tsx';
const cssPath = 'packages/ui/src/styles/0-fonts.css';
const fontFile = 'funnel-sans-latin-wght-normal.woff2';
const bundledFont = /\/funnel-sans-latin-wght-normal-[^/]+\.woff2(?:\?|$)/u;
const variableFace = /@font-face\s*\{\s*font-family:\s*'Funnel Sans';[\s\S]*?\n\}/u;
const pinPath = 'packages/ui/package.json';
const facePackage = '@fontsource-variable/funnel-sans';
const outDir = mkdtempSync(join(tmpdir(), 'fonts-forward-pair-'));
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

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

  // Every path into head, not the anchor's line alone: each commit that
  // changes the face is a red removing it under the named test or the green
  // after it that restores it, paired in order.
  const shown = (commit: string, path: string): string => {
    try {
      return git('show', `${commit}:${path}`);
    } catch {
      return '';
    }
  };
  const faceAt = (commit: string): string => {
    let pinned: unknown;
    try {
      const manifest = JSON.parse(shown(commit, pinPath)) as {
        dependencies?: Record<string, string>;
      };
      pinned = manifest.dependencies?.[facePackage];
    } catch {
      pinned = undefined;
    }
    return `${shown(commit, cssPath).match(variableFace)?.[0] ?? ''}\n${String(pinned)}`;
  };
  const onlySheet = (commit: string): boolean =>
    git('diff-tree', '--no-commit-id', '--name-only', '-r', commit) === cssPath;
  const removesUnderTest = (commit: string): boolean => {
    const test = shown(commit, testPath);
    const before = shown(`${commit}^`, cssPath);
    return (
      onlySheet(commit) &&
      test.includes(fontFile) &&
      test.includes('expect(face).toContain') &&
      variableFace.test(before) &&
      normalise(shown(commit, cssPath)) === normalise(before.replace(variableFace, ''))
    );
  };
  const restores = (removed: string, commit: string): boolean => {
    try {
      git('merge-base', '--is-ancestor', removed, commit);
    } catch {
      return false;
    }
    return (
      onlySheet(commit) &&
      normalise(shown(commit, cssPath)) === normalise(shown(`${removed}^`, cssPath))
    );
  };
  const changes = git(
    'rev-list',
    '--reverse',
    '--full-history',
    '--no-merges',
    `${anchor}..${head}`,
    '--',
    cssPath,
    pinPath,
  )
    .split('\n')
    .filter(Boolean)
    .filter((commit) => faceAt(`${commit}^`) !== faceAt(commit));
  const unpaired: string[] = [];
  let open: string | undefined;
  for (const commit of changes) {
    if (open === undefined && removesUnderTest(commit)) open = commit;
    else if (open !== undefined && restores(open, commit)) open = undefined;
    else unpaired.push(commit);
  }
  if (open !== undefined) unpaired.push(open);
  expect(changes, 'the walk finds the pair it proves').toEqual(
    expect.arrayContaining([red, green]),
  );
  expect(unpaired, 'every change to the face after the anchor has its forward pair').toEqual([]);

  const configFile = fileURLToPath(new URL('../../apps/web/vite.config.ts', import.meta.url));
  await build({ configFile, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  const server = await preview({
    configFile,
    logLevel: 'silent',
    build: { outDir },
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
