// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the Docs commands' data effects (#2493), spread into `COMMAND_EFFECTS`. Docs are the
// business's own rows, held by no client, so each is `business` data.

import type { CommandName } from './command-names.ts';
import { business, writing, type DataEffects } from './data-effects-types.ts';

export const DOCS_EFFECTS: {
  readonly [Name in Extract<CommandName, `docs.${string}`>]: DataEffects;
} = {
  'docs.create_folder': writing(business('docs_folders')),
  'docs.create_page': writing(business('docs_pages', 'docs_page_versions')),
  'docs.update_page': writing(business('docs_pages', 'docs_page_versions')),
  'docs.rename_folder': writing(business('docs_folders')),
  'docs.move_folder': writing(business('docs_folders')),
};
