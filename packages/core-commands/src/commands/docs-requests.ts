// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs command requests (#2493), a member of `CommandRequest` (`requests.ts`). Every
// operand is checked by value in its handler (`docs.ts`).

import type { Envelope } from './request-envelope.ts';

export type DocsRequest =
  | ({
      readonly command: 'docs.create_folder';
      readonly name: unknown;
      readonly parentId?: string;
    } & Envelope)
  | ({
      readonly command: 'docs.create_page';
      readonly folderId: string;
      readonly title: unknown;
      readonly body: unknown;
    } & Envelope)
  | ({
      readonly command: 'docs.update_page';
      readonly pageId: string;
      readonly expectedVersion: unknown;
      readonly title?: unknown;
      readonly body?: unknown;
    } & Envelope);
