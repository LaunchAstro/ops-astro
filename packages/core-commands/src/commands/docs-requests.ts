// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs command requests (#2493), a member of `CommandRequest` (`requests.ts`). Every
// operand is checked by value in its handler (`docs.ts`). `taskId` is an agent's: the task it
// works under (`docs-agent.ts`, #2519); the person path refuses it.

import type { Envelope } from './request-envelope.ts';

export type DocsRequest =
  | ({
      readonly command: 'docs.create_folder';
      readonly name: unknown;
      readonly parentId?: string;
      readonly taskId?: string;
    } & Envelope)
  | ({
      readonly command: 'docs.create_page';
      readonly folderId: string;
      readonly title: unknown;
      readonly body: unknown;
      readonly taskId?: string;
    } & Envelope)
  | ({
      readonly command: 'docs.update_page';
      readonly pageId: string;
      readonly expectedVersion: unknown;
      readonly title?: unknown;
      readonly body?: unknown;
      readonly folderId?: string;
      readonly taskId?: string;
    } & Envelope)
  | ({
      readonly command: 'docs.rename_folder';
      readonly folderId: string;
      readonly name: unknown;
    } & Envelope)
  | ({
      readonly command: 'docs.move_folder';
      readonly folderId: string;
      readonly parentId?: string;
    } & Envelope);
