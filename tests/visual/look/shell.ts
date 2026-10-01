// SPDX-License-Identifier: AGPL-3.0-only
//
// B1, the shell chrome every signed-in page wears: the left rail (SIDEBAR.md Part 2,
// DS-SIDE-11 to 14, 17), the app strip (DS-COMP-1), the page header (DS-COMP-3), the
// content's padding and the dock rail at rest (DS-SIDE-1, its look only). PAGE-MAP SH-*.

import type { LookScreen } from './index.ts';

const BOARD = { path: '/agency/projects/' } as const;
const APP = { page: 'agency:projects-board' } as const;
const ALL = [1480, 900, 390] as const;
const NARROW = [900, 390] as const;

export const SHELL: LookScreen = {
  id: 'shell',
  probes: [
    {
      id: 'shell.rail',
      mockup: { ...BOARD, selector: 'nav.rail' },
      app: { ...APP, selector: 'nav.rail' },
      props: ['background-color', 'border-right-color', 'padding-top', 'box.width'],
    },
    {
      id: 'shell.rail-hub-label',
      mockup: { ...BOARD, selector: '.rail__hub' },
      app: { ...APP, selector: '.rail__hub' },
      props: [
        'font-family',
        'font-size',
        'font-weight',
        'letter-spacing',
        'text-transform',
        'color',
      ],
      // DR-10 folded the dark muted ink to 55 percent; the mockup drew 46.
      ruled: [{ at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' }],
    },
    {
      id: 'shell.rail-item',
      mockup: { ...BOARD, selector: '.rail__group a.rail__item:not(.is-here)' },
      app: { ...APP, selector: '.rail__group a.rail__item:not([aria-current])' },
      props: ['font-family', 'font-size', 'color', 'padding-left', 'box.height'],
    },
    {
      id: 'shell.rail-current',
      mockup: { ...BOARD, selector: '.rail__group a.rail__item[aria-current="page"]' },
      app: { ...APP, selector: '.rail__group a.rail__item[aria-current]' },
      props: ['font-family', 'font-weight', 'color', 'box.y', 'box.height'],
    },
    {
      id: 'shell.rail-brand',
      mockup: { ...BOARD, selector: '.rail__brand' },
      app: { ...APP, selector: '.rail__brand' },
      props: ['padding-left', 'box.y', 'box.height'],
    },
    {
      // Below 900 the rail is a drawer, shut at rest (DS-SIDE-11).
      id: 'shell.rail-drawer',
      mockup: { ...BOARD, selector: 'nav.rail' },
      app: { ...APP, selector: 'nav.rail' },
      props: ['position', 'visibility', 'background-color', 'border-right-color', 'box.width'],
      widths: NARROW,
    },
    {
      id: 'shell.navtoggle',
      mockup: { ...BOARD, selector: '.topbar .navtoggle' },
      app: { ...APP, selector: '.topbar .navtoggle' },
      props: ['color', 'border-top-color', 'box.x', 'box.width', 'box.height'],
      widths: NARROW,
    },
    {
      id: 'shell.appbar',
      mockup: { ...BOARD, selector: '.appbar' },
      app: { ...APP, selector: '.appbar' },
      props: [
        'background-color',
        'color',
        'font-family',
        'font-size',
        'padding-left',
        'padding-top',
        'box.x',
        'box.y',
        'box.width',
        'box.height',
      ],
      widths: ALL,
    },
    {
      id: 'shell.appbar-nav',
      mockup: { ...BOARD, selector: '.appbar__nav button' },
      app: { ...APP, selector: '.appbar__nav button' },
      props: ['color', 'box.x', 'box.y', 'box.width', 'box.height'],
      widths: [1480, 900],
    },
    {
      // Hidden at 900 and below (DS-COMP-1).
      id: 'shell.appbar-search',
      mockup: { ...BOARD, selector: '.appbar__search' },
      app: { ...APP, selector: '.appbar__search' },
      props: [
        'background-color',
        'border-top-color',
        'color',
        'font-size',
        'padding-left',
        'box.x',
        'box.y',
        'box.height',
      ],
    },
    {
      id: 'shell.appbar-kbd',
      mockup: { ...BOARD, selector: '.appbar__kbd' },
      app: { ...APP, selector: '.appbar__kbd' },
      props: ['font-family', 'font-size', 'border-top-color', 'color', 'box.height'],
      // TOKENS.md type census row 39 folds the keycap's 10.88/1.4 into the chip style.
      ruled: (['light', 'dark'] as const).flatMap((theme) => [
        { at: `font-size@${theme}`, want: '11px', why: 'DS-TOK-128' },
        { at: `box.height@${theme}`, want: '13', why: 'DS-TOK-128' },
      ]),
    },
    {
      id: 'shell.appbar-switch',
      mockup: { ...BOARD, selector: '#viewSwitch' },
      app: { ...APP, selector: '.appbar .segmented' },
      props: ['border-top-color', 'box.y', 'box.width', 'box.height'],
      widths: ALL,
    },
    {
      id: 'shell.appbar-switch-on',
      mockup: { ...BOARD, selector: '#viewSwitch button[aria-pressed="true"]' },
      app: { ...APP, selector: '.appbar .segmented__opt[aria-pressed="true"]' },
      props: [
        'background-color',
        'color',
        'font-family',
        'font-size',
        'font-weight',
        'text-transform',
        'box.width',
        'box.height',
      ],
      widths: ALL,
    },
    {
      id: 'shell.appbar-switch-off',
      mockup: { ...BOARD, selector: '#viewSwitch button[aria-pressed="false"]' },
      app: { ...APP, selector: '.appbar .segmented__opt[aria-pressed="false"]' },
      props: ['background-color', 'color', 'font-family', 'font-size', 'box.width'],
      widths: ALL,
    },
    {
      // Its width is left out: the pinned mockup's harness has no icon font, so its
      // play glyph draws nothing there (DS-COMP-1 measures the timer 101 wide).
      id: 'shell.appbar-timer',
      mockup: { ...BOARD, selector: '.appbar__timer' },
      app: { ...APP, selector: '.appbar__timer' },
      props: ['border-top-color', 'color', 'font-size', 'padding-left', 'box.y', 'box.height'],
      widths: [1480, 900],
    },
    {
      id: 'shell.topbar',
      mockup: { ...BOARD, selector: '.topbar' },
      app: { ...APP, selector: '.topbar' },
      props: [
        'border-bottom-color',
        'padding-top',
        'padding-left',
        'padding-right',
        'box.x',
        'box.y',
      ],
      widths: ALL,
    },
    {
      // Its height is the page's own at 900 and below, where the board's controls wrap.
      id: 'shell.topbar-height',
      mockup: { ...BOARD, selector: '.topbar' },
      app: { ...APP, selector: '.topbar' },
      props: ['background-color', 'box.height'],
    },
    {
      id: 'shell.page-title',
      mockup: { ...BOARD, selector: '.topbar h1' },
      app: { ...APP, selector: '.topbar h1' },
      props: ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'color', 'box.x'],
      widths: ALL,
    },
    // At 900 the board's controls share the title's row and set its height, so
    // the title's and the hamburger's heights are held at 1480 and 390. The
    // title's line is 1.1 where the mockup's is 1.15 (DS-TOK-50 folds 1.15 into
    // --lh-title), so it sits half a pixel lower and rounds one pixel down.
    {
      id: 'shell.page-title-y',
      mockup: { ...BOARD, selector: '.topbar h1' },
      app: { ...APP, selector: '.topbar h1' },
      props: ['box.y'],
      ruled: [
        { at: 'box.y@light', want: '61', why: 'DS-TOK-50' },
        { at: 'box.y@dark', want: '61', why: 'DS-TOK-50' },
      ],
    },
    {
      id: 'shell.page-title-y-phone',
      mockup: { ...BOARD, selector: '.topbar h1' },
      app: { ...APP, selector: '.topbar h1' },
      props: ['box.y'],
      widths: [390],
      ruled: [
        { at: 'box.y@light', want: '60', why: 'DS-TOK-50' },
        { at: 'box.y@dark', want: '60', why: 'DS-TOK-50' },
      ],
    },
    {
      id: 'shell.navtoggle-y',
      mockup: { ...BOARD, selector: '.topbar .navtoggle' },
      app: { ...APP, selector: '.topbar .navtoggle' },
      props: ['box.y'],
      widths: [390],
    },
    {
      id: 'shell.content',
      mockup: { ...BOARD, selector: '.content' },
      app: { ...APP, selector: '.content' },
      props: ['padding-top', 'padding-left', 'padding-right', 'box.x', 'box.width'],
      widths: ALL,
    },
    {
      // The dock rail at rest, its look only: the dock itself is slice SL06.
      id: 'shell.dock-rail',
      mockup: { ...BOARD, selector: '.dock__rail' },
      app: { ...APP, selector: '.dock__rail' },
      props: [
        'background-color',
        'border-left-color',
        'border-top-color',
        'border-right-style',
        'padding-top',
        'box.x',
        'box.width',
      ],
    },
  ],
};
