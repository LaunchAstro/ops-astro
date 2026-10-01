// SPDX-License-Identifier: AGPL-3.0-only
//
// The rail's fold, width drag and railmark (SIDEBAR.md DS-SIDE-11, 12, 14 to
// 16; SHELL.md SH-2, SH-7 to SH-9). The folded rail is read on the mockup's
// /dashboard/, the address MP-2-3's visual match names; the app's rail is the
// same on every page, so it is read on the Projects board. The railmark is
// read where both light Projects.
//
// Rulings and defects, not copied: DR-61 moves the fold clear of the wordmark;
// the mockup's folded items are blank 14 px hit areas (DS-SIDE-D1), so an
// item is held to its place, not its height. The mockup's dragged width is
// replayed from its own store (`aa-rail-w`, what its grip writes), and the
// app's grip is dragged by the same 96 px from 224.

import type { LookProbe, LookScreen } from './index.ts';

const DASHBOARD = { path: '/dashboard/' } as const;
const PROJECTS = { path: '/agency/projects/' } as const;
const APP = { page: 'agency:projects-board' } as const;
const FOLD = '.railfold';
const WIDE = [1480];
const NARROW = [900, 390];
const BOX = ['box.x', 'box.y', 'box.width', 'box.height'];
// DR-10 folded the dark muted ink to 55 percent; the mockup drew 46.
const DR10 = { at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' } as const;

/** Folded by its own button, on both sides. */
const folded = (
  id: string,
  selectors: { readonly mockup: string; readonly app: string },
  props: string[],
  ruled?: LookProbe['ruled'],
): LookProbe => ({
  id: `rail.${id}`,
  mockup: { ...DASHBOARD, selector: selectors.mockup, open: FOLD },
  app: { ...APP, selector: selectors.app, open: FOLD },
  props,
  widths: WIDE,
  ...(ruled === undefined ? {} : { ruled }),
});
const same = (selector: string) => ({ mockup: selector, app: selector });

export const RAIL: LookScreen = {
  id: 'rail',
  probes: [
    folded('collapsed', same('nav.rail'), [
      'box.width',
      'padding-top',
      'background-color',
      'border-right-color',
    ]),
    // The planet mark in place of the wordmark, centred in the strip.
    folded('collapsed-mark', { mockup: '.rail__logo', app: '.rail__brand .brand' }, [
      ...BOX,
      'background-color',
    ]),
    folded('collapsed-fold', same(FOLD), [...BOX, 'color'], [DR10]),
    // The first section sits where the mockup's does; its height is D1's.
    folded('collapsed-item', same('.rail__group .rail__item'), ['box.x', 'box.y', 'box.width']),
    {
      id: 'rail.wordmark',
      mockup: { ...DASHBOARD, selector: '.rail__logo' },
      app: { ...APP, selector: '.rail__brand .brand' },
      props: [...BOX, 'background-color'],
      widths: WIDE,
    },
    {
      id: 'rail.fold',
      mockup: { ...DASHBOARD, selector: FOLD },
      app: { ...APP, selector: FOLD },
      props: [...BOX, 'color'],
      // DR-61: on the HUB line, clear of the wordmark's foot (y 42), not touching it.
      ruled: [
        { at: 'box.y@light', want: '44', why: 'DR-61' },
        { at: 'box.y@dark', want: '44', why: 'DR-61' },
        DR10,
      ],
      widths: WIDE,
    },
    // At 900 and below the rail is the drawer: no fold and no grip.
    {
      id: 'rail.fold-narrow',
      mockup: { ...DASHBOARD, selector: FOLD },
      app: { ...APP, selector: FOLD },
      props: ['display'],
      widths: NARROW,
    },
    {
      id: 'rail.grip-narrow',
      mockup: { ...DASHBOARD, selector: '.railgrip' },
      app: { ...APP, selector: '.railgrip' },
      props: ['display'],
      widths: NARROW,
    },
    {
      id: 'rail.dragged',
      mockup: { ...DASHBOARD, selector: 'nav.rail', store: { 'aa-rail-w': '320' } },
      app: { ...APP, selector: 'nav.rail', drag: { selector: '.railgrip', by: 96 } },
      props: ['box.width', 'padding-top'],
      widths: WIDE,
    },
    {
      id: 'rail.dragged-wordmark',
      mockup: { ...DASHBOARD, selector: '.rail__logo', store: { 'aa-rail-w': '320' } },
      app: { ...APP, selector: '.rail__brand .brand', drag: { selector: '.railgrip', by: 96 } },
      props: BOX,
      widths: WIDE,
    },
    {
      id: 'rail.railmark',
      mockup: { ...PROJECTS, selector: '.railmark' },
      app: { ...APP, selector: '.railmark' },
      props: [...BOX, 'background-color', 'opacity'],
      widths: WIDE,
    },
    // In the open drawer the mark stands on the lit section too.
    {
      id: 'rail.railmark-drawer',
      mockup: { ...PROJECTS, selector: '.railmark', open: '.navtoggle' },
      app: { ...APP, selector: '.railmark', open: '.navtoggle' },
      props: [...BOX, 'background-color', 'opacity'],
      widths: NARROW,
    },
  ],
};
