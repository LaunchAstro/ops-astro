// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- the two themes are drawn one at a time */
//
// A field's label, hint and error are text a person needs to fill the field
// in, so each reaches WCAG AA's 4.5:1 against the card it sits on. The colours
// are the ones Chromium resolves under the shipped sheets, each painted over
// the page and card grounds, so a translucent ink is measured as it shows.

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TextField } from '../../packages/ui/src/kit/controls-fields.tsx';
import { drawn } from './shipped-sheets.ts';

const ignore = (): void => undefined;

const CARD = renderToStaticMarkup(
  <div className="card">
    <TextField label="Client name" hint="As it appears on invoices" value="" onChange={ignore} />
    <TextField label="Ceiling" error="Enter an amount in dollars" value="" onChange={ignore} />
  </div>,
);

const PARTS = { label: '.field__label', hint: '.field__hint', error: '.field__error' };

/** Each part's contrast with the card, measured in the page. */
const contrastIn = (theme: 'light' | 'dark') =>
  drawn(CARD, { theme }, (page) =>
    page.evaluate((parts) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const pen = canvas.getContext('2d', { willReadFrequently: true });
      if (pen === null) throw new Error('no 2d canvas');
      /** The sRGB pixel the colours make, painted one over the other. */
      const paint = (colours: readonly string[]): readonly number[] => {
        pen.clearRect(0, 0, 1, 1);
        for (const colour of colours) {
          pen.fillStyle = colour;
          pen.fillRect(0, 0, 1, 1);
        }
        return Array.from(pen.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
      const luminance = (rgb: readonly number[]): number => {
        const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
          const c = channel / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
      const colourOf = (selector: string, property: 'color' | 'backgroundColor'): string => {
        const node = document.querySelector(selector);
        if (node === null) throw new Error(`no ${selector}`);
        return getComputedStyle(node)[property];
      };
      const grounds = [
        colourOf('html', 'backgroundColor'),
        colourOf('body', 'backgroundColor'),
        colourOf('.card', 'backgroundColor'),
      ];
      const card = luminance(paint(grounds));
      return Object.fromEntries(
        Object.entries(parts).map(([part, selector]) => {
          const text = luminance(paint([...grounds, colourOf(selector, 'color')]));
          const ratio = (Math.max(text, card) + 0.05) / (Math.min(text, card) + 0.05);
          return [part, Math.round(ratio * 100) / 100];
        }),
      );
    }, PARTS),
  );

it('a field label, hint and error reach 4.5:1 on the card in both themes', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const ratios = await contrastIn(theme);
    for (const part of Object.keys(PARTS)) {
      expect(ratios[part], `${theme} ${part}`).toBeGreaterThanOrEqual(4.5);
    }
  }
}, 30_000);
