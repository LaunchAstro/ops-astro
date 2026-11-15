// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs commands' operands (#2493), spread into `WRITE_OPERANDS` in `write-operands.ts`.
// Each is checked by value in its handler (`core-commands/src/commands/docs.ts`), which names
// the field it refuses.

export const DOCS_OPERANDS = {
  'docs.create_folder': { name: 'any', parentId: 'id?' },
  'docs.create_page': { folderId: 'id', title: 'any', body: 'any' },
  'docs.update_page': {
    pageId: 'id',
    expectedVersion: 'any',
    title: 'any?',
    body: 'any?',
    folderId: 'id?',
  },
  'docs.rename_folder': { folderId: 'id', name: 'any' },
  'docs.move_folder': { folderId: 'id', parentId: 'id?' },
} as const;
