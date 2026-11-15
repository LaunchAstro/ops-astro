// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the section blocks spread into `COMMAND_EFFECTS` (`data-effects.ts`, at its line cap): the
// review workspace's (C35, C57) and Docs' (#2493), each in its own file.

import { REVIEW_EFFECTS } from './data-effects-review.ts';
import { DOCS_EFFECTS } from './data-effects-docs.ts';

export const SECTION_EFFECTS: typeof REVIEW_EFFECTS & typeof DOCS_EFFECTS = {
  ...REVIEW_EFFECTS,
  ...DOCS_EFFECTS,
};
