// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs handlers (#2493), spread into `handlers.ts`'s table, which is at its line cap.

import type { Handler } from './handler-types.ts';
import { fileDocsFolder, fileDocsPage, reviseDocsPage } from './docs.ts';
import { moveFolder, renameFolder } from './docs-folders.ts';

type DocsWrite =
  | 'docs.create_folder'
  | 'docs.create_page'
  | 'docs.update_page'
  | 'docs.rename_folder'
  | 'docs.move_folder';

export const DOCS_HANDLERS: { readonly [K in DocsWrite]: Handler<K> } = {
  'docs.create_folder': fileDocsFolder,
  'docs.create_page': fileDocsPage,
  'docs.update_page': reviseDocsPage,
  'docs.rename_folder': renameFolder,
  'docs.move_folder': moveFolder,
};
