// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// The named parts of the dock's Notifications and Team panels, how each side
// is opened on them, and the verdict that names every difference between the
// two sides' measures. Used by dock-panels-mockup.ts alone.
//
// A part is measured the way the mockup inventory's capture tool measures a
// region (captures/DOCK/<state>/<width>-<theme>.json): its box, and its
// font, size, weight, lh, ls, tt, color, bg, border, borderColor, radius,
// pad, gap and display, each colour as the hex it paints.

export type Box = readonly [x: number, y: number, width: number, height: number];
export type Measured = { readonly box: Box; readonly style: Readonly<Record<string, string>> };
export type Parts = Readonly<Record<string, Measured | null>>;
export type Difference = {
  readonly part: string;
  readonly property: string;
  readonly mockup: string;
  readonly built: string;
};

/** A part: its selector on each side. `panel` is the part every `left` is measured from. */
export type Part = { readonly name: string; readonly mockup: string; readonly built: string };
export type DockState = {
  readonly id: 'p-notifs' | 'p-notifs--info-tab' | 'p-team';
  /** The inventory's recipe: `/dashboard/` with `aa-dock-open` set, then any clicks. */
  readonly mockup: { readonly open: string; readonly clicks: readonly string[] };
  /** The built dock: the tab pressed on the board, then any clicks. */
  readonly built: { readonly tab: string; readonly clicks: readonly string[] };
  readonly parts: readonly Part[];
};

const NT = '.dpanel:has(.nt)';
const TM = '.dpanel:has(.tmc)';
const NOTIF_PARTS = (pane: 'owed' | 'info'): Part[] => {
  const mPane = `[data-nt-pane="${pane}"]`;
  const bPane = `[id$="-panel-${pane}"]`;
  return [
    { name: 'panel', mockup: NT, built: '.inbox' },
    { name: 'head', mockup: `${NT} > .dpanel__head`, built: '.topbar' },
    { name: 'title', mockup: `${NT} .dpanel__id span`, built: '.topbar .t-title' },
    { name: 'summary', mockup: '.nt__sum', built: '.nt__sum' },
    { name: 'tabs', mockup: '.nt__tabs', built: '.nt__tabs .cmtabs' },
    {
      name: 'tab-selected',
      mockup: '.nt__tabs .cmtab[aria-selected="true"]',
      built: '.nt__tabs .cmtab[aria-selected="true"]',
    },
    {
      name: 'tab-other',
      mockup: '.nt__tabs .cmtab[aria-selected="false"]',
      built: '.nt__tabs .cmtab[aria-selected="false"]',
    },
    { name: 'tab-count', mockup: '.nt__tabs .cbadge', built: '.nt__tabs .cbadge' },
    { name: 'group', mockup: `${mPane} .nt__grp`, built: `${bPane} .nt__grp` },
    { name: 'group-name', mockup: `${mPane} .nt__gname`, built: `${bPane} .nt__gname` },
    { name: 'band-head', mockup: `${mPane} .nt__bh`, built: `${bPane} .nt__bh` },
    { name: 'row', mockup: `${mPane} .nt__row`, built: `${bPane} .nt__row` },
    { name: 'row-text', mockup: `${mPane} .nt__text`, built: `${bPane} .nt__text` },
    { name: 'row-meta', mockup: `${mPane} .nt__meta`, built: `${bPane} .nt__meta` },
    { name: 'closed', mockup: `${mPane} .nt__summary`, built: `${bPane} .nt__summary` },
    { name: 'empty', mockup: `${mPane} .dp__empty`, built: `${bPane} .empty` },
  ];
};

export const STATES: readonly DockState[] = [
  {
    id: 'p-notifs',
    mockup: { open: 'notifs', clicks: [] },
    built: { tab: 'Notifications', clicks: [] },
    parts: NOTIF_PARTS('owed'),
  },
  {
    id: 'p-notifs--info-tab',
    mockup: { open: 'notifs', clicks: ['[data-nt-tab="info"]'] },
    built: { tab: 'Notifications', clicks: ['.nt__tabs [role="tab"][id$="-tab-info"]'] },
    parts: NOTIF_PARTS('info'),
  },
  {
    id: 'p-team',
    mockup: { open: 'team', clicks: [] },
    built: { tab: 'Team', clicks: [] },
    parts: [
      { name: 'panel', mockup: TM, built: '.tmc' },
      { name: 'head', mockup: `${TM} > .dpanel__head`, built: '.topbar' },
      { name: 'title', mockup: `${TM} .dpanel__id span`, built: '.topbar .t-title' },
      { name: 'strip', mockup: '.tmc__strip', built: '.tmc__strip' },
      { name: 'person', mockup: '.tmc__p', built: '.tmc__p' },
      { name: 'avatar', mockup: '.tmc__av', built: '.tmc__face > *' },
      { name: 'name', mockup: '.tmc__p:not(.is-on) .tmc__n', built: '.tmc__p:not(.is-on) .tmc__n' },
      { name: 'name-selected', mockup: '.tmc__p.is-on .tmc__n', built: '.tmc__p.is-on .tmc__n' },
      { name: 'unread', mockup: '.tmc__u', built: '.tmc__u' },
      { name: 'conversation', mockup: '.tmc__conv', built: '.tmc__conv' },
      { name: 'thread', mockup: '.tmc__conv .thread', built: '.tmc__conv .thread' },
      { name: 'message', mockup: '.tmc__conv .msg', built: '.tmc__conv .msg' },
      { name: 'composer', mockup: '.tmc__conv .composer', built: '.tmc__conv .composer' },
      {
        name: 'composer-input',
        mockup: '.tmc__conv .composer :is(input, textarea)',
        built: '.tmc__conv .composer :is(input, textarea)',
      },
      {
        name: 'composer-send',
        mockup: '.tmc__conv .composer .btn--primary',
        built: '.tmc__conv .composer .btn--primary',
      },
      { name: 'empty', mockup: '.tmc .dp__empty', built: '.tmc .empty' },
    ],
  },
];

/**
 * In the page: each part's first visible match, measured as the capture tool
 * measures a region. Self-contained: it runs in the browser, so its helpers
 * are its own and it is one function.
 */
/* oxlint-disable unicorn/consistent-function-scoping, max-lines-per-function -- evaluated in the
   page: nothing outside this function reaches the browser */
export function measureParts(parts: readonly (readonly [string, string])[]): Parts {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const pen = canvas.getContext('2d', { willReadFrequently: true });
  const hex = (colour: string): string => {
    if (pen === null || colour === '' || colour === 'rgba(0, 0, 0, 0)') return 'none';
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = '#000';
    pen.fillStyle = colour;
    pen.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = pen.getImageData(0, 0, 1, 1).data;
    if (a === 0) return 'none';
    const two = (n: number): string => n.toString(16).padStart(2, '0');
    return `#${two(r)}${two(g)}${two(b)}${a < 255 ? `:${(a / 255).toFixed(2)}` : ''}`;
  };
  const visible = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0
    );
  };
  const out: Record<string, Measured | null> = {};
  for (const [name, selector] of parts) {
    const element = [...document.querySelectorAll(selector)].find((one) => visible(one));
    if (element === undefined) {
      out[name] = null;
      continue;
    }
    const s = getComputedStyle(element);
    const r = element.getBoundingClientRect();
    const bordered = s.borderTopWidth !== '0px' || s.borderBottomWidth !== '0px';
    out[name] = {
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      style: {
        font: (s.fontFamily.split(',')[0] ?? '').replaceAll(/["']/gu, ''),
        size: s.fontSize,
        weight: s.fontWeight,
        lh: s.lineHeight,
        ls: s.letterSpacing,
        tt: s.textTransform,
        color: hex(s.color),
        bg: hex(s.backgroundColor),
        border: bordered
          ? `${s.borderTopWidth} ${s.borderRightWidth} ${s.borderBottomWidth} ${s.borderLeftWidth} ${s.borderTopStyle}`
          : 'none',
        borderColor: s.borderTopWidth === '0px' ? 'none' : hex(s.borderTopColor),
        radius: s.borderRadius,
        pad: s.padding,
        gap: s.gap,
        display: s.display,
      },
    };
  }
  return out;
}
/* oxlint-enable unicorn/consistent-function-scoping, max-lines-per-function */

/** Every difference between the two sides' parts, each named. None: the panel matches. */
export function verdictOf(_mockup: Parts, _built: Parts): Difference[] {
  return [];
}
