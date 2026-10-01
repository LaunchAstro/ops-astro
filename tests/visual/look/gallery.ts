// SPDX-License-Identifier: AGPL-3.0-only
//
// B7, the component gallery (`/gallery/`, MP-1-3): the kit's primitives as
// the gallery draws them, each held to the same primitive where the mockup
// draws it (catalogue/PRIMITIVES.md names each one's construction and
// usages). Every screen is built from these, so a value moved here moves
// everywhere; the other screens' probes keep that honest.
//
// The mockup pages are the ones that draw each primitive on load, visible,
// as the first match of its selector. No mockup page draws the canonical
// `.tf__in` text input, the block empty state (`.cbd__empty`) or a list row
// on load, so those three are not probed here. The tab set (`.cmtabs`) is
// not on the gallery, and the made-up task page draws none, so it waits too.

import type { LookProbe, LookScreen } from './probe.ts';

const APP = { page: 'agency:gallery' } as const;
const TYPE = ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'color'] as const;
const BOX = ['padding-top', 'padding-left', 'box.height'] as const;
const EDGE = ['border-top-color', 'border-top-width', 'border-left-color', 'background-color'];

/** The element the gallery draws for one catalogue id in one state. */
const at = (id: string, state: string, inner = ''): string =>
  `[data-catalogue-id="${id}"] [data-gallery-state="${state}"]${inner === '' ? '' : ` ${inner}`}`;

const probe = (
  id: string,
  mockup: { path: string; selector: string; open?: string },
  app: string,
  props: readonly string[],
  extra: Partial<LookProbe> = {},
): LookProbe => ({
  id: `gallery.${id}`,
  mockup,
  app: { ...APP, selector: app },
  props,
  ...extra,
});

/** One ruled value in both themes. */
const themed = (
  prop: string,
  want: string,
  why: string,
): { at: string; want: string; why: string }[] =>
  (['light', 'dark'] as const).map((theme) => ({ at: `${prop}@${theme}`, want, why }));

const EXECUTIVE = '/agency/executive/';
const PROJECTS = '/agency/projects/';
const BRIEF = '/agency/brief/';
const CONNECTIONS = '/agency/connections-and-signal/';

export const GALLERY_LOOK: LookScreen = {
  id: 'gallery',
  probes: [
    // DS-PRIM-1: the house `--sm` button in its three variants and disabled.
    probe(
      'button-primary',
      { path: EXECUTIVE, selector: '.afeed__rows .btn--primary' },
      at('DS-PRIM-1', 'Primary', '.btn'),
      [...TYPE, ...BOX, ...EDGE],
      { widths: [1480, 390] },
    ),
    probe(
      'button-secondary',
      { path: PROJECTS, selector: '.cbd__acts .btn--secondary' },
      at('DS-PRIM-1', 'Secondary', '.btn'),
      [...TYPE, ...BOX, ...EDGE],
    ),
    probe(
      'button-ghost',
      { path: EXECUTIVE, selector: '.paction__btns .btn--ghost' },
      at('DS-PRIM-1', 'Ghost', '.btn'),
      [...TYPE, ...BOX, ...EDGE],
    ),
    probe(
      'button-primary-disabled',
      { path: '/agency/clients/', selector: '.btn--primary:disabled' },
      at('DS-PRIM-1', 'Primary disabled', '.btn'),
      ['color', 'background-color', 'border-top-color', 'opacity', 'cursor'],
      // The one drawn disabled primary is the board's Clear (`.cbd__clear`,
      // opacity .32, default cursor); the house rule is the outline at full
      // opacity (DR-22, `A:2012`) with the not-allowed cursor (shared states).
      {
        ruled: [
          ...themed('opacity', '1', 'DR-22'),
          ...themed('cursor', 'not-allowed', 'PRIMITIVES shared state rules, disabled'),
        ],
      },
    ),
    probe(
      'button-secondary-disabled',
      {
        path: '/clients/meridian-dental/account/settings/',
        selector: '.setrow__ctl .btn--secondary:disabled',
      },
      at('DS-PRIM-1', 'Secondary disabled', '.btn'),
      ['color', 'background-color', 'border-top-color', 'opacity', 'cursor'],
    ),
    // DS-PRIM-5: the field select (the portal's request form).
    probe(
      'select',
      { path: '/client-portal/contact/', selector: '.form .sel__btn' },
      at('DS-PRIM-5', 'Closed', '.sel__btn'),
      [...TYPE, 'padding-left', 'box.height', 'border-top-color', 'background-color'],
      // The portal draws 14.4 on surface-2: the canonical body is 14
      // (DS-TOK-117, R53) and the field ground is paper on both faces (DR-25).
      {
        ruled: [
          ...themed('font-size', '14px', 'DS-TOK-117 14'),
          { at: 'background-color@light', want: 'rgba(255,255,255,255)', why: 'DR-25' },
          { at: 'background-color@dark', want: 'rgba(10,10,13,255)', why: 'DR-25' },
        ],
      },
    ),
    // DS-PRIM-7: the checkbox, unchecked (a task row's tick box).
    probe(
      'checkbox',
      { path: PROJECTS, selector: '.cbd__name .sbbox' },
      at('DS-PRIM-7', 'Unchecked', '[role="checkbox"]'),
      ['box.width', 'box.height', 'border-top-color', 'border-top-width', 'background-color'],
    ),
    // DS-PRIM-9: the switch, off (the agentic-scope rows).
    probe(
      'switch',
      { path: CONNECTIONS, selector: '.grad__act .autosw:not([aria-checked="true"])' },
      at('DS-PRIM-9', 'Off', '[role="switch"]'),
      ['box.width', 'box.height', 'border-top-color', 'border-top-width', 'background-color'],
    ),
    // DS-PRIM-10: the segmented control on paper, and the facet.
    probe(
      'segmented-on',
      {
        path: '/clients/meridian-dental/account/settings/',
        selector: '[data-set="theme"] .segmented button[aria-pressed="true"]',
      },
      at('DS-PRIM-10', 'Segmented', '[aria-pressed="true"]'),
      [...TYPE, 'text-transform', 'background-color', 'padding-left', 'box.height'],
    ),
    probe(
      'facet',
      { path: CONNECTIONS, selector: '.facets .facet:not([aria-pressed="true"])' },
      at('DS-PRIM-10', 'Facet', '.facet:not([aria-pressed="true"])'),
      [...TYPE, 'padding-left', 'box.height', 'border-top-color', 'background-color'],
      // .82rem paints 13.12; the canonical small text is 13 (DS-TOK-120, R53).
      { ruled: themed('font-size', '13px', 'DS-TOK-120 13') },
    ),
    // DS-PRIM-11 and DS-PRIM-15: the chip, soft and as a status mark.
    probe(
      'chip-soft',
      { path: '/agency/portfolio/', selector: '.chip--soft' },
      at('DS-PRIM-11', 'Soft', '.chip'),
      [
        ...TYPE,
        'text-transform',
        'padding-left',
        'box.height',
        'border-top-color',
        'border-top-left-radius',
      ],
    ),
    probe(
      'status-warn',
      { path: '/client-portal/library/docs/', selector: '.doc__meta .chip.is-warn' },
      at('DS-PRIM-15', 'Chip, warn', '.chip'),
      ['font-family', 'font-size', 'text-transform', 'color', 'border-top-color', 'box.height'],
    ),
    // DS-PRIM-20: the table head cell and a body row's cell.
    probe(
      'table-head',
      { path: EXECUTIVE, selector: '.table thead th' },
      at('DS-PRIM-20', 'Default, sorted by hours', 'thead th'),
      [
        ...TYPE,
        'text-transform',
        'padding-top',
        'padding-left',
        'border-bottom-color',
        'border-bottom-width',
      ],
      { widths: [1480, 390] },
    ),
    probe(
      'table-cell',
      { path: EXECUTIVE, selector: '.table tbody td' },
      at('DS-PRIM-20', 'Default, sorted by hours', 'tbody td'),
      [...TYPE, 'padding-top', 'padding-left', 'border-bottom-color', 'border-bottom-width'],
    ),
    // DS-PRIM-21: the card and its head.
    probe(
      'card',
      { path: BRIEF, selector: '.mrow > .card' },
      at('DS-PRIM-21', 'Default', '.card'),
      ['padding-top', 'padding-left', 'row-gap', ...EDGE],
    ),
    probe(
      'card-title',
      { path: BRIEF, selector: 'section.sec .card__head .card__title' },
      at('DS-PRIM-21', 'Default', '.card__title'),
      TYPE,
      // The canonical card title (DS-TOK-119) is 15/1.1, as settings holds it.
      { ruled: themed('line-height', '16.5px', 'DS-TOK-119 15/1.1') },
    ),
    // DS-PRIM-22: the banner, info and failure.
    probe(
      'banner-info',
      { path: EXECUTIVE, selector: '.content > .banner--info' },
      at('DS-PRIM-22', 'Info', '.banner'),
      [
        'font-family',
        'font-size',
        'color',
        'padding-top',
        'padding-left',
        'border-top-color',
        'border-left-color',
        'border-left-width',
        'background-color',
      ],
      { widths: [1480, 390] },
    ),
    probe(
      'banner-bad',
      { path: CONNECTIONS, selector: '#fleetBanner .banner--bad' },
      at('DS-PRIM-22', 'Failure', '.banner'),
      ['border-top-color', 'border-left-color', 'border-left-width', 'background-color'],
    ),
    // DS-PRIM-18: the explained term.
    probe(
      'term',
      { path: BRIEF, selector: '.stat__label .term' },
      at('DS-PRIM-18', 'Below', '.term'),
      ['border-bottom-style', 'border-bottom-color', 'border-bottom-width', 'cursor'],
    ),
    // DS-PRIM-32: the mock mark's word chip (its corner place is the kit's, 0276096).
    probe(
      'mock-word',
      { path: BRIEF, selector: '.vrow__src .unwired-tag' },
      at('DS-PRIM-32', 'Region', '.mocktag'),
      [...TYPE, 'text-transform', 'border-top-color', 'padding-left'],
      // The mockup paints the word on `::after` (1px --border, padding 0 .3rem);
      // the box measured here is its unbordered host.
      {
        ruled: [
          { at: 'border-top-color@light', want: 'rgba(0,0,0,31)', why: 'DS-PRIM-32 word chip' },
          {
            at: 'border-top-color@dark',
            want: 'rgba(245,245,245,26)',
            why: 'DS-PRIM-32 word chip',
          },
          ...themed('padding-left', '4.8px', 'DS-PRIM-32 word chip'),
        ],
      },
    ),
  ],
};
