// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs commands' names (#2493), part of `CommandName` (`command-names.ts`).
// In a file that imports nothing, as `surface-review-names.ts` is.

/**
 * A person files a folder, a page under one, a new version of a page, and renames or moves a
 * folder; the folder tree and one page are read.
 */
export type DocsCommandName =
  | 'docs.create_folder'
  | 'docs.create_page'
  | 'docs.update_page'
  | 'docs.rename_folder'
  | 'docs.move_folder'
  | 'docs.tree'
  | 'docs.page';
