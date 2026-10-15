// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// The new standing approval form under Graduation, drawn in Chromium under the
// shipped sheets. The sentence is the words a person writes, so above 640 px it
// takes three shares of the row's spare room to the ceiling's and the date's
// one each; at phone width it still takes the whole row.

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MandateForm } from '../../apps/web/src/screens/connections/graduation-forms.tsx';
import { drawn } from './shipped-sheets.ts';

const ignore = (): void => undefined;

const FORM = renderToStaticMarkup(
  <section className="gradsec">
    <MandateForm scopes={['*']} file={ignore} locked={false} />
  </section>,
);

const widthsAt = (width: number) =>
  drawn(FORM, { width }, (page) =>
    page.evaluate(() => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
      const measure = (selector: string): number =>
        document.querySelector(selector)?.getBoundingClientRect().width ?? 0;
      return {
        row: measure('.psadd'),
        sentence: measure('[data-mandate-label]'),
        ceiling: measure('[data-mandate-ceiling]'),
        expiry: measure('[data-mandate-expiry]'),
      };
    }),
  );

it('the mandate sentence gets three times the ceiling and date share above 640 px', async () => {
  const wide = await widthsAt(1280);
  const basis = 128;
  expect(wide.ceiling).toBeCloseTo(wide.expiry, 0);
  expect(wide.sentence - basis).toBeCloseTo(3 * (wide.ceiling - basis), -1);

  const phone = await widthsAt(390);
  expect(phone.sentence).toBeCloseTo(phone.row, 0);
}, 30_000);
