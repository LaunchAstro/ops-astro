// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's body (MP-4-8; PAGE-MAP TASKS S1 to S3, TASK-PAGE.md):
// the name, the Team and Agent tabs, the fact strip, the field grid, the
// description and the subtasks head.
//
// The mockup opens it by pressing a task's row on `/agency/projects/` (its name
// waits 260ms for a double-click, so the client cell); the
// app by pressing a to-do's name on `/todos`. The panel's frame (DS-SIDE-7,
// its head buttons DS-SIDE-8 and 9) is the dock frame's (MP-3-1), not this
// body's, so it is not measured here.
//
// At 1480 only: below it the mockup's dock rail sits under the page, so a
// press cannot open the panel there (the width-and-theme harness covers the
// app's narrower widths).

import type { LookProbe, LookScreen } from './probe.ts';

const MOCKUP = {
  path: '/agency/projects/',
  open: 'tbody tr[data-taskrow] td:nth-child(4)',
} as const;
const PANEL = '[data-dock-panel="task"]';
const APP = { page: 'agency:todos', open: '[data-todo-open]' } as const;
const BODY = '[data-task-panel]';
// DR-10 folded the dark muted ink to 55 percent; the mockup drew 46.
const MUTED_DARK = { at: 'color@dark', want: 'rgba(248,248,248,140)', why: 'DR-10' } as const;
const TYPE = ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform'];

const probe = (
  id: string,
  selectors: { mockup: string; app: string },
  props: readonly string[],
  extra: Partial<LookProbe> = {},
): LookProbe => ({
  id,
  mockup: { ...MOCKUP, selector: `${PANEL} ${selectors.mockup}` },
  app: { ...APP, selector: `${BODY} ${selectors.app}` },
  props,
  ...extra,
});

export const TASK_PANEL: LookScreen = {
  id: 'task-panel',
  probes: [
    // DP-08: the name, an inline field in the display face.
    probe('task-panel.name', { mockup: '.sb__name', app: '[data-panel-field="name"]' }, [
      ...TYPE,
      'color',
      'padding-left',
      'border-top-color',
      'border-top-width',
      'background-color',
    ]),
    // DP-11 to DP-13: the Team and Agent tabs and their mark.
    probe(
      'task-panel.tab',
      {
        mockup: '[data-tasktabs] .cmtab[aria-selected="true"]',
        app: '[data-tabs="panel-perspective"] .cmtab[aria-selected="true"]',
      },
      [...TYPE, 'color', 'padding-top', 'padding-bottom'],
    ),
    probe(
      'task-panel.tab-mark',
      {
        mockup: '[data-tasktabs] .cmtabs__mark',
        app: '[data-tabs="panel-perspective"] .cmtabs__mark',
      },
      ['background-color', 'box.height'],
    ),
    // DP-14 to DP-17: the fact strip's keys, a derived value and a tick.
    probe('task-panel.fact-key', { mockup: '.mstrip__k', app: '.tpr__fact .tf__k' }, [
      ...TYPE,
      'color',
    ]),
    probe(
      'task-panel.fact-rank',
      { mockup: '.mstrip__rank', app: '[data-fact="rank"] .sb__state' },
      ['font-family', 'font-size', 'color'],
    ),
    probe(
      'task-panel.fact-tick',
      { mockup: '[data-mstrip-fact="ad-hoc"] .sbbox', app: '[data-tick="adhoc"]' },
      ['box.width', 'box.height', 'border-top-color', 'background-color'],
    ),
    // DP-18 to DP-25: the field grid's keys and selects.
    probe(
      'task-panel.field-key',
      { mockup: '.sb__grid .tf__k', app: '.dtp__fields .tf__k' },
      [...TYPE, 'color'],
      { ruled: [MUTED_DARK] },
    ),
    probe(
      'task-panel.select',
      // The estimate: the assignee's select carries a 22px face, which sets its height.
      {
        mockup: '.sb__grid .tf__row:nth-child(4) .sel__btn',
        app: '.dtp__fields #panel-field-estimate',
      },
      [
        'font-family',
        'font-size',
        'color',
        'padding-left',
        'border-top-color',
        'background-color',
        'box.height',
      ],
    ),
    // DP-35: the description.
    probe(
      'task-panel.description',
      { mockup: '.tf__ta[data-sb="detail"]', app: '[data-writing="description"]' },
      ['font-family', 'font-size', 'color', 'padding-left', 'border-top-color', 'background-color'],
    ),
    // DT-01 and DT-02: the subtasks head and the add line.
    probe(
      'task-panel.section-key',
      { mockup: '[data-task-pane="human"] .sb__sect .sb__k', app: '[data-steps] .sb__k' },
      [...TYPE, 'color'],
      { ruled: [MUTED_DARK] },
    ),
    probe('task-panel.subtask-add', { mockup: '.sbadd__in', app: '[data-step-add]' }, [
      'font-family',
      'font-size',
      'color',
      'padding-left',
      'border-top-width',
      'background-color',
    ]),
  ],
};
