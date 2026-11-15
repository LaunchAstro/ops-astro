// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs screen's writes (#2515, piece 4b), by the web-writes rule (`data/owned.ts`): one
// operation id per intent, made once and reused when the same act is pressed again after an
// answer that never arrived, so the server replays what it stored; any answer ends the intent.
// Each write is tagged for the business and person it was sent for, and an answer for an owner
// the screen has left is dropped. The server's refusal is shown in its own words, except a save
// against a version the page has moved past, which is the plain "changed since you opened it".

import { useCallback } from 'react';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { ownerOf, useDesk } from '../../data/owned.ts';
import { describeRefusal } from '../../records/submit.ts';
import type { CommandName } from '../../../../../packages/core-wire/src/index.ts';

export const CHANGED_SINCE_OPENED =
  'This page changed since you opened it. Copy your words, reopen the page, and save again.';

/** What one Docs write came to, for the screen that sent it. */
export type DocsAnswer =
  | { readonly kind: 'done'; readonly detail: Readonly<Record<string, unknown>> }
  | { readonly kind: 'refused'; readonly words: string }
  /** The screen answers to another business or person now: draw nothing. */
  | { readonly kind: 'left' };

/** The writes the Docs screen sends, each under `docs:write` on the business. */
export type DocsWriteName = Extract<
  CommandName,
  | 'docs.create_folder'
  | 'docs.create_page'
  | 'docs.update_page'
  | 'docs.rename_folder'
  | 'docs.move_folder'
>;

export type DocsSend = (
  intent: string,
  name: DocsWriteName,
  body: Readonly<Record<string, unknown>>,
) => Promise<DocsAnswer>;

/** The screen's Docs writes, each under its intent's one operation id. */
export function useDocsWrite(client: OperationsClient, grantKey: string): DocsSend {
  const desk = useDesk(ownerOf(client, grantKey));
  return useCallback<DocsSend>(
    async (intent, name, body) => {
      const tag = desk.save();
      const { id } = desk.intents.attempt(intent, body, null);
      const result = await client.mutate(name, body, { operationId: id });
      if (!desk.owns(tag)) return { kind: 'left' };
      // No answer came: the intent stays, so pressing again sends the same id.
      if (isUnavailable(result)) return { kind: 'refused', words: result.because };
      desk.intents.answered(intent, id);
      if (isRefusal(result)) {
        return {
          kind: 'refused',
          words: result.code === 'VERSION_STALE' ? CHANGED_SINCE_OPENED : describeRefusal(result),
        };
      }
      // The answer is the command's outcome under `value` (`operations/client.ts`).
      return { kind: 'done', detail: result.value.detail ?? {} };
    },
    [client, desk],
  );
}
