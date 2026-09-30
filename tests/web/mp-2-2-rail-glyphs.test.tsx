// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-2, each rail section's own glyph (SIDEBAR.md T-R4, DS-SIDE-D1). The
// mockup keyed its icons by legacy address only, so on every canonical address
// the folded rail was a column of blank hit areas. Here every navigable section
// of every face names one glyph from the licensed set (MP-1-2), distinct within
// its face, and the rail draws it hidden beside the label until the rail folds
// (MP-2-3): the expanded rail stays text, as the mockup's owner ruled.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLYPH_NAMES } from '../../packages/ui/src/index.ts';
import { SECTIONS } from '../../apps/web/src/manifest.ts';
import { RAIL_GLYPHS } from '../../apps/web/src/rail-glyphs.ts';
import { open } from './mp-2-1-support.tsx';
import { layout } from './frame-support.tsx';

const shellCss = readFileSync(resolve('packages/ui/src/styles/3-shell.css'), 'utf8');

const navigable = SECTIONS.filter((each) => each.navigable);
const keyOf = (section: (typeof SECTIONS)[number]): string => `${section.namespace}:${section.id}`;

let undo: () => void = () => {};
beforeEach(() => {
  undo = layout();
});
afterEach(() => {
  undo();
});

describe('MP-2-2 each rail section has its own glyph', () => {
  it('names a licensed glyph for every navigable section of every face, and nothing else', () => {
    expect(Object.keys(RAIL_GLYPHS).toSorted()).toStrictEqual(navigable.map(keyOf).toSorted());
    for (const [key, glyph] of Object.entries(RAIL_GLYPHS)) {
      expect(GLYPH_NAMES, key).toContain(glyph);
    }
  });

  it('keeps the glyphs distinct within each face, so a folded rail is never ambiguous', () => {
    for (const namespace of new Set(navigable.map((each) => each.namespace))) {
      const glyphs = navigable
        .filter((each) => each.namespace === namespace)
        .map((each) => RAIL_GLYPHS[keyOf(each)]);
      expect(new Set(glyphs).size, namespace).toBe(glyphs.length);
    }
  });

  it.each([
    ['the Hub', '/dashboard/'],
    ['a client', '/clients/acme-dental/projects/'],
  ])('draws each section of %s with its glyph, hidden from the name', async (_face, address) => {
    const { view } = await open(address);
    const items = view.all('.rail .rail__group .rail__item');
    expect(items.length).toBeGreaterThan(0);
    const drawn = items.map((item) =>
      item.querySelector('.rail__icon')?.getAttribute('data-glyph'),
    );
    for (const [index, item] of items.entries()) {
      const icon = item.querySelector('.rail__icon');
      expect(icon?.getAttribute('aria-hidden'), item.textContent ?? '').toBe('true');
      expect(icon?.querySelector('svg'), item.textContent ?? '').not.toBeNull();
      expect(GLYPH_NAMES).toContain(drawn[index]);
      // The label still names the item; the glyph adds nothing to its name.
      expect(item.textContent?.trim()).not.toBe('');
    }
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it('keeps the expanded rail text only: the glyph is not displayed until the rail folds', () => {
    const block = /(?:^|\n|\})\s*\.rail__icon\s*\{([^}]*)\}/u.exec(shellCss)?.[1] ?? '';
    expect(block).toMatch(/display:\s*none/u);
  });
});
