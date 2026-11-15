// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs reads' operands and answers (#2493 piece 2), joined into `ReadOperands` and
// `ReadResult` through `section-read-operands.ts`.

import type { DocsPageResult, DocsTreeResult } from '../../../core-wire/src/index.ts';

/** The business's folder tree takes nothing; one page takes its id. */
export interface DocsReadOperands {
  readonly 'docs.tree': Readonly<Record<never, never>>;
  readonly 'docs.page': { readonly pageId: string };
}

export type DocsReadsResult = DocsTreeResult | DocsPageResult;
