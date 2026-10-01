// SPDX-License-Identifier: AGPL-3.0-only
//
// SL10, `/inbox/` (MP-7-3): the Notifications panel's list in full-page form
// (CS-7.39). The mockup's `/inbox/` is a route placeholder, so the list is
// held to the mockup's dock panel `p-notifs`, opened by its bell. The panel
// sits in the dock and the page fills the frame, so widths are not compared:
// the list's type, colour, spacing and row height are. At 900 and 390 the
// mockup's page covers its bell, so the panel is measured at 1480 in both
// themes; the narrower widths are the harness captures' (no sideways scroll).

import type { LookScreen } from './types.ts';

const PANEL = { path: '/agency/projects/', open: '[data-dock-tab="notifs"]' } as const;
const APP = { page: 'agency:inbox' } as const;
/** `p-notifs--info-tab`: the panel on its "No response needed" tab. */
const INFO = {
  mockup: { path: PANEL.path, open: [PANEL.open, '[data-nt-tab="info"]'] },
  app: { ...APP, open: '[role="tab"][id$="-tab-info"]' },
} as const;
const TYPE = ['font-family', 'font-size', 'font-weight', 'line-height', 'color'] as const;

/** A mockup size TOKENS.md folds onto the scale ("drift, drop"), in both themes. */
const folded = (size: string, lineHeight: string, why: string) =>
  (['light', 'dark'] as const).flatMap((theme) => [
    { at: `font-size@${theme}`, want: size, why },
    { at: `line-height@${theme}`, want: lineHeight, why },
  ]);
// 12.8 and 13.6 fold to --type-small (13/1.55), 11 to --type-caption (12/1.55).
const SMALL = folded('13px', '20.15px', 'DS-TOK-120');
const CAPTION = folded('12px', '18.6px', 'DS-TOK-122');

export const INBOX: LookScreen = {
  id: 'inbox',
  probes: [
    {
      id: 'inbox.summary',
      mockup: { ...PANEL, selector: '.nt__sum' },
      app: { ...APP, selector: '.nt__sum' },
      props: [...TYPE],
      ruled: SMALL,
    },
    {
      id: 'inbox.group-name',
      mockup: { ...PANEL, selector: '.nt__gname' },
      app: { ...APP, selector: '.nt__gname' },
      props: [...TYPE, 'letter-spacing', 'text-transform'],
      ruled: SMALL,
    },
    {
      // The owner's own words in the mockup (app.css:10660): 4px inside each
      // card, 8px between cards. A card's height follows its text, so it is not
      // compared: the made-up rows are not the mockup's.
      id: 'inbox.row',
      mockup: { ...PANEL, selector: '.nt__row' },
      app: { ...APP, selector: '.nt__row' },
      props: ['padding-top', 'padding-bottom', 'padding-left', 'border-left-width'],
    },
    {
      id: 'inbox.band',
      mockup: { ...PANEL, selector: '.nt__band' },
      app: { ...APP, selector: '.nt__band' },
      props: ['row-gap'],
    },
    {
      id: 'inbox.row-text',
      mockup: { ...PANEL, selector: '.nt__text' },
      app: { ...APP, selector: '.nt__text' },
      props: [...TYPE],
      ruled: SMALL,
    },
    {
      id: 'inbox.row-meta',
      mockup: { ...PANEL, selector: '.nt__meta' },
      app: { ...APP, selector: '.nt__meta' },
      props: [...TYPE],
      ruled: CAPTION,
    },
    {
      id: 'inbox.info-tab',
      mockup: { ...INFO.mockup, selector: '[data-nt-tab="info"]' },
      app: { ...INFO.app, selector: '[role="tab"][id$="-tab-info"]' },
      props: [...TYPE, 'padding-top', 'padding-bottom', 'border-bottom-color'],
      ruled: SMALL,
    },
    {
      id: 'inbox.info-row',
      mockup: { ...INFO.mockup, selector: '[data-nt-pane="info"] .nt__row' },
      app: { ...INFO.app, selector: '[id$="-panel-info"] .nt__row' },
      props: ['padding-top', 'padding-bottom', 'padding-left', 'border-left-width'],
    },
  ],
};
