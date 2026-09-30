// SPDX-License-Identifier: AGPL-3.0-only
//
// B6, sign in. The mockup has no sign-in page, so each element is held to the
// same element where the mockup draws it: the brand mark (the rail's
// wordmark), the field label and input (DS-COMP-26's `.tf__k` and `.tf__in`,
// in the library's link adder), the primary button (the plan's call to
// action) and the card and its title (DS-PRIM-21, the account settings card).
// The page is drawn signed out and without the shell.

import type { LookProbe, LookScreen } from './index.ts';

const APP = { page: 'agency:sign-in' } as const;
const WIDTHS = [1480, 900, 390] as const;
const ADDER = {
  path: '/client-portal/library/docs/',
  open: '[data-asset-open]',
} as const;

const probe = (
  id: string,
  mockup: LookProbe['mockup'],
  app: string,
  props: readonly string[],
): LookProbe => ({
  id: `sign-in.${id}`,
  mockup,
  app: { ...APP, selector: app },
  props,
  widths: WIDTHS,
});

export const SIGN_IN: LookScreen = {
  id: 'sign-in',
  probes: [
    probe(
      'brand',
      { path: '/agency/projects/', selector: '.rail__logo' },
      '.signin .brand--wordmark',
      ['background-color', 'box.width', 'box.height'],
    ),
    probe(
      'card',
      { path: '/clients/meridian-dental/account/settings/', selector: '.set__card' },
      '.signin__form',
      ['background-color', 'border-top-color', 'border-top-width', 'padding-top', 'padding-left'],
    ),
    probe(
      'title',
      { path: '/clients/meridian-dental/account/settings/', selector: '.set__card > .card__title' },
      '.signin__form .card__title',
      ['font-family', 'font-size', 'font-weight', 'line-height', 'color'],
    ),
    {
      ...probe(
        'label',
        { ...ADDER, selector: '.lassetadd .tf__k' },
        '.signin label[for="signin-email"]',
        ['font-family', 'font-size', 'letter-spacing', 'text-transform', 'color'],
      ),
      // DR-10 folded the dark faint and muted inks to 55 percent; the mockup drew 46.
      ruled: [{ at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' }],
    },
    // The adder focuses its first input on opening; the second is at rest.
    probe('input', { ...ADDER, selector: '.lassetadd input[data-af="what"]' }, '#signin-email', [
      'font-family',
      'font-size',
      'color',
      'background-color',
      'border-top-color',
      'border-top-width',
      'padding-left',
    ]),
    // The house button is `--sm` (DS-PRIM-1); the plan's call to action is the
    // mockup's one unsized primary, so it gives the fill and the Reset the size.
    probe(
      'button',
      {
        path: '/clients/meridian-dental/account/settings/',
        selector: '[data-set="tips"] .btn--sm',
      },
      '.signin .btn--primary',
      ['font-family', 'font-size', 'font-weight', 'padding-left', 'box.height'],
    ),
    probe(
      'button-fill',
      { path: '/clients/meridian-dental/account/plan/', selector: '#planCta .btn--primary' },
      '.signin .btn--primary',
      ['color', 'background-color'],
    ),
  ],
};
