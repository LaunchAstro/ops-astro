// SPDX-License-Identifier: AGPL-3.0-only
//
// Priority eligibility is a list of the six journey stages, each at most once,
// answered in journey order. `priorityStageIds` is the application's check
// before a write; anything else answers undefined, never a cleaned-up list.

import { describe, expect, it } from 'vitest';
import { priorityStageIds } from '../../packages/core-wire/src/task-stages.ts';

describe('priority stage ids', () => {
  it.each([
    ['null', null],
    ['a string', 'awareness'],
    ['an object', { awareness: true }],
    ['a number in the list', [1]],
    ['an object in the list', [{}]],
    ['a list in the list', [['awareness']]],
    ['a duplicate', ['trust', 'trust']],
    ['an unknown id', ['awareness', 'leads']],
    ['the Ops fallback', ['ops']],
    ['a label for an id', ['Awareness']],
    ['seven ids', ['awareness', 'trust', 'enquiries', 'sales', 'retention', 'advocacy', 'trust']],
  ])('refuses %s', (_label, value) => {
    expect(priorityStageIds(value)).toBeUndefined();
  });

  it('answers an empty list as no stage', () => {
    expect(priorityStageIds([])).toStrictEqual([]);
  });

  it('answers the stages in journey order, whatever order they came in', () => {
    expect(priorityStageIds(['advocacy', 'awareness', 'sales'])).toStrictEqual([
      'awareness',
      'sales',
      'advocacy',
    ]);
  });

  it('answers all six', () => {
    expect(
      priorityStageIds(['awareness', 'trust', 'enquiries', 'sales', 'retention', 'advocacy']),
    ).toHaveLength(6);
  });
});
