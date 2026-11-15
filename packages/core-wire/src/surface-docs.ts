// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs commands' rows (#2493 piece 1), spread into `COMMAND_SURFACE` in `surface.ts`.
//
// Each is `docs:write` on the business: Docs are the business's own, so a grant held at one
// client reaches none of it, and the store asks the grant again once its rows are held
// (`core-records/src/docs/store.ts`). An agent reaches the three page and folder filings (not a folder's rename or move) inside a delegation that
// carries `docs:write` itself, naming in `taskId` the task it works under: the agent entry asks
// the delegation on that task (`docs-agent.ts`, #2519). A person names no task.

import type { CommandDeclaration } from './surface-declaration.ts';
import { declare, read } from './surface-builders.ts';

const DOCS_COLLECTION = 'docs';

const ON_THE_BUSINESS = (untargetedIdentifiers: readonly string[]) =>
  ({ collection: DOCS_COLLECTION, targetsExistingRecord: false, untargetedIdentifiers }) as const;

/** A write an agent also reaches, naming in `taskId` the task its delegation is on. */
const AND_AN_AGENT = (identifiers: readonly string[]) =>
  ({ ...ON_THE_BUSINESS([...identifiers, 'taskId']), agent: 'delegated' }) as const;

export const DOCS_SURFACE: readonly CommandDeclaration[] = [
  declare('docs.create_folder', 'write', AND_AN_AGENT(['parentId'])),
  declare('docs.create_page', 'write', AND_AN_AGENT(['folderId'])),
  declare('docs.update_page', 'write', AND_AN_AGENT(['pageId', 'folderId'])),
  // #2514: a folder renamed or moved inside the business, by a person only.
  declare('docs.rename_folder', 'write', ON_THE_BUSINESS(['folderId'])),
  declare('docs.move_folder', 'write', ON_THE_BUSINESS(['folderId', 'parentId'])),
  // The reads are `docs:read` on the business (#2493 piece 2): a grant at one client reads none.
  read('docs.tree', DOCS_COLLECTION),
  read('docs.page', DOCS_COLLECTION),
];
