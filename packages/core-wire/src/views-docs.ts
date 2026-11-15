// SPDX-License-Identifier: AGPL-3.0-only
//
// What the Docs reads answer (#2493 piece 2): the business's folder tree with each page's title,
// and one page with its Markdown body and the version a save starts from.

import type { DocsFolderRow, DocsPageEntry, DocsPageRow } from '../../core-records/src/index.ts';

export interface DocsTreeResult {
  readonly ok: true;
  readonly folders: readonly DocsFolderRow[];
  readonly pages: readonly DocsPageEntry[];
}

export interface DocsPageResult {
  readonly ok: true;
  /** `document`, not `page`, which a board answer already names for its rows. */
  readonly document: DocsPageRow;
}
