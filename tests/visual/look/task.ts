// SPDX-License-Identifier: AGPL-3.0-only
//
// B4, the task page (TASK-PAGE.md; PAGE-MAP TASKS S5 to S8). The header and
// facts are measured on the mockup's gate task (Team, as it opens); the gate
// box on its Agent perspective. The app draws the made-up T-1, whose one
// proposal waits at an armed gate and whose run has a receipt (made-up-api.ts).
// The perspective tabs, the fact strip (sample values behind the mock label)
// and the receipt box (`.sout`, the mockup's live task) follow.

import type { LookProbe, LookScreen } from './probe.ts';

const MOCK = { path: '/agency/task/?task=proj-meridian-hero-copy' } as const;
const OPEN_AGENT = '[role=tab]:has-text("Agent")';
const AGENT = { ...MOCK, open: OPEN_AGENT } as const;
const LIVE = { path: '/agency/task/?task=proj-blue-schema-live', open: OPEN_AGENT } as const;
const APP = { page: 'agency:task-detail' } as const;
const TABS = '[data-tabs="perspective"]';
const TEAM = '[data-tp-pane="team"]';
const ALL = [1480, 900, 390] as const;
const TYPE: readonly string[] = ['font-family', 'font-size', 'font-weight', 'color'];

const probe = (
  id: string,
  mockup: LookProbe['mockup'],
  app: string,
  props: readonly string[],
  ruled?: LookProbe['ruled'],
): LookProbe => ({
  id: `task.${id}`,
  mockup,
  // A probe the mockup measures on its Agent perspective opens the app's too.
  app: { ...APP, selector: app, ...(mockup.open === undefined ? {} : { open: mockup.open }) },
  props,
  widths: ALL,
  ...(ruled === undefined ? {} : { ruled }),
});

// TP-06: the title is DS-TOK-107 --type-display; the mockup's 600 weight,
// 1.15 leading and -0.01em tracking are drift (TASK-PAGE.md S5).
const DISPLAY = (['light', 'dark'] as const).flatMap((theme) => [
  { at: `font-weight@${theme}`, want: '500', why: 'TP-06' },
]);
// DS-TASK-1 and DS-TASK-7: labels snap to DS-TOK-126 --type-eyebrow (300);
// the mockup's 400 is drift (TASK-PAGE.md S4).
const EYEBROW = (['light', 'dark'] as const).map((theme) => ({
  at: `font-weight@${theme}`,
  want: '300',
  why: 'DS-TASK-1',
}));
// TP-01: the crumb's door link is DS-TOK-124 (mono 12); the mockup drew 13.
const DOOR = (['light', 'dark'] as const).map((theme) => ({
  at: `font-size@${theme}`,
  want: '12px',
  why: 'TP-01',
}));

export const TASK: LookScreen = {
  id: 'task',
  probes: [
    probe('crumb', { ...MOCK, selector: '.tpr__crumb' }, '.tpr__crumb', [...TYPE, 'column-gap']),
    probe(
      'crumb-door',
      { ...MOCK, selector: '.tpr__crumb a.sb__addr' },
      '.tpr__crumb a.sb__addr',
      ['font-family', 'font-size', 'color', 'text-decoration-line'],
      DOOR,
    ),
    probe('state', { ...MOCK, selector: '.tpr__crumb .spill' }, '.tpr__crumb .spill', [
      'font-size',
    ]),
    probe(
      'title',
      { ...MOCK, selector: '.tpr__title' },
      '.tpr__title',
      ['font-family', 'font-size', 'font-weight', 'color'],
      DISPLAY,
    ),
    probe('runline', { ...MOCK, selector: '.tpr .card__sub' }, '.tpr .card__sub', [
      'font-size',
      'color',
    ]),
    probe('header', { ...MOCK, selector: '.tpr' }, '.tpr', ['row-gap', 'margin-bottom']),
    probe('facts', { ...MOCK, selector: '.tpr__facts .taskform' }, '.tpr__facts .taskform', [
      'background-color',
      'border-top-color',
      'border-top-width',
      'padding-top',
      'padding-left',
      'padding-bottom',
    ]),
    probe('facts-grid', { ...MOCK, selector: '.tpr__facts .tf__grid' }, '.tpr__facts .tf__grid', [
      'row-gap',
      'column-gap',
    ]),
    probe(
      'fact-key',
      { ...MOCK, selector: '.tpr__facts .tf__k' },
      '.tpr__facts .tf__k',
      [...TYPE, 'text-transform', 'letter-spacing'],
      EYEBROW,
    ),
    probe('fact-value', { ...MOCK, selector: '.tpr__facts .sb__state' }, '.tpr__facts .sb__state', [
      ...TYPE,
      'padding-top',
    ]),
    probe('section', { ...MOCK, selector: '.sb__sect' }, `${TEAM} > .sb__sect`, [
      'border-top-color',
      'border-top-width',
      'padding-top',
      'padding-left',
      'row-gap',
    ]),
    probe('section-key', { ...MOCK, selector: '.sb__sect .sb__k' }, `${TEAM} > .sb__sect .sb__k`, [
      ...TYPE,
      'text-transform',
    ]),
    probe('gatebox', { ...AGENT, selector: '.gatebox' }, '.gatebox', [
      'border-top-color',
      'border-top-width',
      'padding-top',
      'row-gap',
    ]),
    probe('gate', { ...AGENT, selector: '.gatebox .gate' }, '.gatebox .gate', [
      'background-color',
      'border-left-color',
      'border-left-width',
      'border-top-color',
      'padding-top',
      'padding-left',
    ]),
    probe(
      'gate-word',
      { ...AGENT, selector: '.gatebox .gate__word' },
      '.gatebox .gate__word',
      [...TYPE, 'text-transform'],
      EYEBROW,
    ),
    probe('gate-say', { ...AGENT, selector: '.gatebox .gate__say' }, '.gatebox .gate__say', [
      ...TYPE,
    ]),
    probe(
      'gate-row-key',
      { ...AGENT, selector: '.gatebox .sout__row .tf__k' },
      '.gatebox .sout__row .tf__k',
      TYPE,
      EYEBROW,
    ),
    probe('gate-rows', { ...AGENT, selector: '.gatebox .sout__box' }, '.gatebox .sout__box', [
      'border-top-color',
      'background-color',
    ]),
    probe(
      'gate-approve',
      { ...AGENT, selector: '.gatebox__acts .btn--primary' },
      '.gatebox__acts .btn--primary',
      ['font-size', 'background-color', 'color', 'box.height'],
    ),
    probe(
      'gate-changes',
      { ...AGENT, selector: '.gatebox__acts .btn--secondary' },
      '.gatebox__acts .btn:not(.btn--primary)',
      ['font-size', 'border-top-color', 'color', 'box.height'],
    ),
    // TP-12: the Team | Agent switch (DS-COMP-23, static) and its one count.
    probe('tabs', { ...MOCK, selector: '[data-tp-tabs]' }, TABS, ['column-gap']),
    probe(
      'tab-on',
      { ...MOCK, selector: '[data-tp-tabs] .cmtab[aria-selected="true"]' },
      `${TABS} .cmtab[aria-selected="true"]`,
      [...TYPE, 'padding-top', 'padding-bottom'],
    ),
    probe(
      'tab-off',
      { ...MOCK, selector: '[data-tp-tabs] .cmtab[aria-selected="false"]' },
      `${TABS} .cmtab[aria-selected="false"]`,
      ['font-size', 'color'],
    ),
    probe(
      'tab-mark',
      { ...MOCK, selector: '[data-tp-tabs] .cmtabs__mark' },
      `${TABS} .cmtabs__mark`,
      ['background-color', 'box.height', 'box.width'],
    ),
    probe('tab-count', { ...MOCK, selector: '[data-tp-tabs] .cbadge' }, `${TABS} .cbadge`, [
      'font-family',
      'font-size',
      'color',
      'background-color',
    ]),
    // DS-TASK-1, read-only: the strip above the field grid (sample values).
    probe('strip', { ...MOCK, selector: '.tpr__facts .mstrip' }, '.tpr__facts .mstrip', [
      'border-bottom-color',
      'border-bottom-width',
      'padding-bottom',
      'margin-bottom',
      'row-gap',
      'column-gap',
    ]),
    probe(
      'strip-key',
      { ...MOCK, selector: '.mstrip .mstrip__k' },
      '.mstrip .mstrip__k',
      [...TYPE, 'text-transform'],
      EYEBROW,
    ),
    probe(
      'strip-move',
      { ...MOCK, selector: '.mstrip [data-mstrip-fact="whose-move"] .mstrip__v' },
      '.mstrip [data-mstrip-fact="whose-move"] .mstrip__v',
      TYPE,
    ),
    probe(
      'strip-rank',
      { ...MOCK, selector: '.mstrip .mstrip__v--none' },
      '.mstrip .mstrip__v--none',
      ['font-size', 'font-style', 'color'],
    ),
    // DS-TASK-6, live: the receipt of an attempt (states.json `receipt`).
    probe('receipt-box', { ...LIVE, selector: '.sout .sout__box' }, '.sout .sout__box', [
      'border-top-color',
      'border-top-width',
      'padding-top',
      'row-gap',
    ]),
    probe(
      'receipt-key',
      { ...LIVE, selector: '.sout .sout__row .tf__k' },
      '.sout .sout__row .tf__k',
      TYPE,
      EYEBROW,
    ),
    probe('receipt-value', { ...LIVE, selector: '.sout .sout__v' }, '.sout .sout__v', [
      'font-family',
      'font-size',
      'color',
    ]),
  ],
};
