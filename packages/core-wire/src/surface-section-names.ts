// SPDX-License-Identifier: AGPL-3.0-only
//
// The section commands' names, part of `CommandName` (`command-names.ts`, at its line cap): the
// review workspace's (C35, C57) and Docs' (#2493). Type-only.

import type { ReviewCommandName } from './surface-review-names.ts';
import type { DocsCommandName } from './surface-docs-names.ts';

export type SectionCommandName = ReviewCommandName | DocsCommandName;
