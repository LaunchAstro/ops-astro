// SPDX-License-Identifier: AGPL-3.0-only
//
// The fast-forward is pinned to the base only while nobody can rewind the
// default branch. Unless its protection reads force pushes off, deletions off and
// administrators included, the publish sends nothing (`ANCESTRY_NOT_ENFORCED`):
// unprotected, unreadable, or any one setting off. Mutant that turns it red: drop
// any one field check, and that case sends.

import { expect, it } from 'vitest';
import { mergeAndFind } from '../../packages/core-connectors/src/index.ts';
import { APPROVED, BEFORE, ENFORCED, binding, proposed } from './c80-site-provider.ts';

const cases: readonly (readonly [string, unknown])[] = [
  ['unprotected', undefined],
  ['force pushes allowed', { ...ENFORCED, allow_force_pushes: { enabled: true } }],
  ['deletions allowed', { ...ENFORCED, allow_deletions: { enabled: true } }],
  ['administrators exempt', { ...ENFORCED, enforce_admins: { enabled: false } }],
  [
    'a setting missing',
    { allow_force_pushes: { enabled: false }, enforce_admins: { enabled: true } },
  ],
];

it.each(cases)('sends nothing when the default branch is %s', async (_, protection) => {
  const site = proposed();
  site.state.protection = protection;
  expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
    kind: 'refused',
    code: 'ANCESTRY_NOT_ENFORCED',
  });
  expect(site.sent.filter((sent) => sent.method !== 'GET')).toEqual([]);
  expect(site.state.content).toBe(BEFORE);
  expect(site.state.mainHead).toBe('base-commit');
});
