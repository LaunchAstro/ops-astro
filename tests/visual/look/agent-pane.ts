// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent section of the task page (MP-6-1, MP-6-2, MP-6-5; TASKS S3 and S6,
// the Agent perspective). Measured on the mockup's rich agent task, opened on
// its Agent tab; the app draws the made-up T-1, whose run waits at an armed
// gate with its knowledge, token ledger and a waiting stop (made-up-agent.ts).
// Each probe id names the ticket whose visual match it carries.

import type { LookProbe, LookScreen } from './probe.ts';

const MOCK = {
  path: '/agency/task/?task=proj-meridian-hero-copy',
  open: '[role=tab]:has-text("Agent")',
} as const;
// The app draws the agent section on its Agent perspective too, so it opens there.
const APP = { page: 'agency:task-detail', open: MOCK.open } as const;
const ALL = [1480, 900, 390] as const;
const TYPE: readonly string[] = ['font-family', 'font-size', 'font-weight', 'color'];

const probe = (
  id: string,
  selector: { readonly mockup: string; readonly app: string },
  props: readonly string[],
  widths: readonly number[] = ALL,
  ruled?: LookProbe['ruled'],
): LookProbe => ({
  id: `agent-pane.${id}`,
  mockup: { ...MOCK, selector: `.tpg ${selector.mockup}` },
  app: { ...APP, selector: `.tpg ${selector.app}` },
  props,
  widths,
  ...(ruled === undefined ? {} : { ruled }),
});

// DS-TASK-7: the gate's label snaps to DS-TOK-126 --type-eyebrow (300); the
// mockup's 400 is drift (TASK-PAGE.md S4), as the task page's probes rule.
const EYEBROW = (['light', 'dark'] as const).map((theme) => ({
  at: `font-weight@${theme}`,
  want: '300',
  why: 'DS-TASK-7',
}));
// DR-10 folded the dark muted ink to 55 percent; the mockup drew 46.
const MUTED_DARK = [{ at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' }];

// DS-TASK-13 and DS-TASK-14 snap the map's titles to the scale (TASK-PAGE.md
// S7): the card title to DS-TOK-121 (500, the mockup drew 600), the
// inspector's to DS-TOK-119 (Sans 15 600, the mockup drew 16 400).
const SMALL_STRONG = (['light', 'dark'] as const).map((theme) => ({
  at: `font-weight@${theme}`,
  want: '500',
  why: 'DS-TOK-121',
}));
const CARD_TITLE = (['light', 'dark'] as const).flatMap((theme) => [
  { at: `font-weight@${theme}`, want: '600', why: 'DS-TOK-119' },
  { at: `font-size@${theme}`, want: '15px', why: 'DS-TOK-119' },
]);

const same = (selector: string): { mockup: string; app: string } => ({
  mockup: selector,
  app: selector,
});

export const AGENT_PANE: LookScreen = {
  id: 'agent-pane',
  probes: [
    // MP-6-1: the staged box and the gate (the run summary is the dock panel's, not S6's).
    probe('mp-6-1.staged-box', same('.sout__box'), [
      'border-top-color',
      'border-top-width',
      'padding-top',
      'row-gap',
    ]),
    probe('mp-6-1.gatebox', same('.gatebox'), [
      'background-color',
      'border-top-color',
      'border-left-width',
      'padding-top',
      'padding-left',
    ]),
    probe(
      'mp-6-1.gate-word',
      same('.gate__word'),
      [...TYPE, 'letter-spacing', 'text-transform'],
      ALL,
      EYEBROW,
    ),
    // MP-6-2: the section heads, the hero stats and the 21rem side column.
    probe(
      'mp-6-2.section-key',
      same('.sb__sh .sb__k'),
      [...TYPE, 'letter-spacing', 'text-transform'],
      ALL,
      MUTED_DARK,
    ),
    probe('mp-6-2.hero-n', same('.tph__n'), TYPE),
    probe('mp-6-2.side', same('.tpg__side'), ['box.width'], [1480]),
    // MP-6-3: the execution map's card (the first, a done step: the quiet
    // left rule), its title, the inspector's title and the legend's line.
    probe('mp-6-3.node', same('.tg__node'), [
      'background-color',
      'border-top-color',
      'border-left-color',
      'border-left-width',
    ]),
    probe('mp-6-3.node-box', same('.tg__node'), ['box.width', 'box.height'], [1480]),
    probe('mp-6-3.node-title', same('.tg__nt'), TYPE, ALL, SMALL_STRONG),
    probe('mp-6-3.inspector-title', same('.tg__insp__t'), TYPE, ALL, CARD_TITLE),
    probe('mp-6-3.legend-line', same('.tg__lline'), ['border-top-color', 'border-top-width']),
    // MP-6-5: the token panel's per-run figures and the allowance bar.
    probe('mp-6-5.run-n', same('.tokrun__n'), TYPE),
    probe('mp-6-5.bar', same('.tt__bar'), ['background-color', 'box.height']),
  ],
};
