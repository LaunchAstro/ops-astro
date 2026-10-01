// SPDX-License-Identifier: AGPL-3.0-only
//
// The task stage list (owner, Stage 1 adds, 30 Sep 2026; the mockup's
// TASK_STAGES, WIRING §43): the six journey stages, Awareness to Advocacy, in
// journey order, then Ops, the one internal stage, appended in one place. A
// task stores the stage's id; every surface reads the label from here.

import { describe, expect, it } from 'vitest';
import { TASK_STAGES } from '../../packages/core-wire/src/index.ts';

describe('the task stage list', () => {
  it('lists the six journey stages in order, then Ops last and alone internal', () => {
    const list = TASK_STAGES.list();
    expect(list.map((stage) => [stage.id, stage.label, stage.internal])).toStrictEqual([
      ['awareness', 'Awareness', false],
      ['trust', 'Trust', false],
      ['enquiries', 'Enquiries', false],
      ['sales', 'Sales', false],
      ['retention', 'Retention', false],
      ['advocacy', 'Advocacy', false],
      ['ops', 'Ops', true],
    ]);
    expect(list.every((stage) => stage.say.length > 0)).toBe(true);
  });

  it('reads a stored stage defended: an unknown or missing value is Ops, never dropped', () => {
    expect([
      TASK_STAGES.of('sales'),
      TASK_STAGES.of('ops'),
      TASK_STAGES.of('Drafting'),
      TASK_STAGES.of(null),
    ]).toStrictEqual(['sales', 'ops', 'ops', 'ops']);
  });

  it('names a stored stage by its label, and a value outside the list as it is stored', () => {
    expect([
      TASK_STAGES.labelOf('enquiries'),
      TASK_STAGES.labelOf('ops'),
      TASK_STAGES.labelOf('Drafting'),
    ]).toStrictEqual(['Enquiries', 'Ops', 'Drafting']);
    expect([
      TASK_STAGES.idOf('Sales'),
      TASK_STAGES.idOf('Ops'),
      TASK_STAGES.idOf('Review'),
    ]).toStrictEqual(['sales', 'ops', 'Review']);
  });
});
