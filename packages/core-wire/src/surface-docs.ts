// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs commands' rows (#2493 piece 1), spread into `COMMAND_SURFACE` in `surface.ts`.
//
// Each is `docs:write` on the business: Docs are the business's own, so a grant held at one
// client reaches none of it, and the store asks the grant again once its rows are held
// (`core-records/src/docs/store.ts`). The key catalogue lets an agent hold `docs:write` inside
// its delegation; the agent path does not serve these yet (#2493 piece 3), so they are `never`
// here until it does, as the tag commands are.

import type { CommandDeclaration } from './surface-declaration.ts';
import { declare, read } from './surface-builders.ts';

const DOCS_COLLECTION = 'docs';

const ON_THE_BUSINESS = (untargetedIdentifiers: readonly string[]) =>
  ({ collection: DOCS_COLLECTION, targetsExistingRecord: false, untargetedIdentifiers }) as const;

export const DOCS_SURFACE: readonly CommandDeclaration[] = [
  declare('docs.create_folder', 'write', ON_THE_BUSINESS(['parentId'])),
  declare('docs.create_page', 'write', ON_THE_BUSINESS(['folderId'])),
  declare('docs.update_page', 'write', ON_THE_BUSINESS(['pageId', 'folderId'])),
  // #2514: a folder renamed or moved inside the business.
  declare('docs.rename_folder', 'write', ON_THE_BUSINESS(['folderId'])),
  declare('docs.move_folder', 'write', ON_THE_BUSINESS(['folderId', 'parentId'])),
  // The reads are `docs:read` on the business (#2493 piece 2): a grant at one client reads none.
  read('docs.tree', DOCS_COLLECTION),
  read('docs.page', DOCS_COLLECTION),
];
