// SPDX-License-Identifier: AGPL-3.0-only
//
// The section blocks spread into `handlers.ts`'s table, which is at its line cap: the review
// workspace's (C35, C57) and Docs' (#2493), each in its own file.

import { REVIEW_HANDLERS } from './handlers-review.ts';
import { DOCS_HANDLERS } from './handlers-docs.ts';

export const SECTION_HANDLERS: typeof REVIEW_HANDLERS & typeof DOCS_HANDLERS = {
  ...REVIEW_HANDLERS,
  ...DOCS_HANDLERS,
};
