// SPDX-License-Identifier: AGPL-3.0-only
//
// The section pairs the acceptance administrator holds, spread into `ADMIN_EXTRA_PAIRS`
// (`cast.ts`, at its line cap), one each, as the seed's admin holds them.

import type { Action } from '../../packages/core-records/src/index.ts';

export const SECTION_PAIRS: readonly (readonly [string, Action])[] = [
  // C35 (#2011, #2012): a page review opened, its capture asked and read, and pins on it.
  ['review', 'write'],
  ['review', 'read'],
  ['review', 'comment'],
  // C57 (#2016): a client pin filed as a change request, and decided.
  ['proposal', 'write'],
  ['proposal', 'decide'],
  // Docs (#2493): folders and pages filed, and read.
  ['docs', 'write'],
  ['docs', 'read'],
];
