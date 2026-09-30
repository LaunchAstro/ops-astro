// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-2's brand marks: the wordmark and planet are the rights holder's own
// SVGs, drawn as masks. Split from mp-1-2-fonts-icons-brand.test.tsx for the
// lint ratchet's file size; the test is as it was.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { BrandMark } from '../../packages/ui/src/primitives/BrandMark.tsx';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ui = `${root}packages/ui/`;
const read = (path: string): string => readFileSync(path, 'utf8');

it('MP-1-2 the wordmark and planet masks are present', () => {
  for (const [variant, file, viewBox] of [
    ['wordmark', 'wordmark.svg', '0 0 566.93 57.9'],
    ['planet', 'planet.svg', '0 0 566.93 463.61'],
  ] as const) {
    const svg = read(`${ui}src/brand/${file}`);
    expect(svg).toContain(`viewBox="${viewBox}"`);
    // A mask image is drawn, never run: no script, handler, link or foreign content.
    expect(svg).not.toMatch(
      /<script|\son[a-z]+\s*=|href|<foreignObject|url\(|<!ENTITY|<!DOCTYPE/iu,
    );
    const html = renderToStaticMarkup(<BrandMark variant={variant} />);
    expect(html).toContain(`brand brand--${variant}`);
    expect(html).toContain('aria-hidden="true"');
  }
  const shell = read(`${ui}src/styles/3-shell.css`);
  expect(shell).toMatch(/\.brand--wordmark\s*\{[^}]*mask:\s*url\('\.\.\/brand\/wordmark\.svg'\)/su);
  expect(shell).toMatch(/\.brand--planet\s*\{[^}]*mask:\s*url\('\.\.\/brand\/planet\.svg'\)/su);
});
