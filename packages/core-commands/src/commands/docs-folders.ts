// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs piece 4a (#2514): a folder renamed or moved inside the business, over the store's
// `renameDocsFolder` and `moveDocsFolder` (`core-records/src/docs/folders.ts`).
//
// Each is `docs:write` on the business, asked again by the store once its rows are held. A folder
// that is not in this business is `NOT_FOUND` on the field that named it, the answer a fabricated
// id gets. A move under the folder itself or one of its own subfolders is refused on `parentId`;
// a name the target folder holds already, in any case, is `UNIQUE_VALUE_TAKEN` on `name`.

import { docsNameOf, moveDocsFolder, renameDocsFolder } from '../../../core-records/src/index.ts';
import { invalid, NAME_FIX, NOT_GRANTED, notFound, writerOf } from './docs.ts';
import type { Handler } from './handler-types.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

const TAKEN = refused(
  refuseCommand(
    'UNIQUE_VALUE_TAKEN',
    ['name'],
    ['That folder already holds a folder of this name.'],
  ),
);

const done = (folderId: string): HandlerOutcome =>
  applied(null, null, { folderId: folderId.toLowerCase() });

export const renameFolder: Handler<'docs.rename_folder'> = async (tx, context, request) => {
  const name = docsNameOf(request.name);
  if (name === undefined) return invalid('name', NAME_FIX);
  const outcome = await renameDocsFolder(tx, writerOf(context), {
    folderId: request.folderId,
    name,
  });
  if (outcome.kind === 'no-folder') return notFound('folderId', 'folder');
  if (outcome.kind === 'not-granted') return NOT_GRANTED;
  if (outcome.kind === 'taken') return TAKEN;
  return done(request.folderId);
};

export const moveFolder: Handler<'docs.move_folder'> = async (tx, context, request) => {
  const outcome = await moveDocsFolder(tx, writerOf(context), {
    folderId: request.folderId,
    parentId: request.parentId ?? null,
  });
  if (outcome.kind === 'no-folder') return notFound('folderId', 'folder');
  if (outcome.kind === 'no-parent') return notFound('parentId', 'folder');
  if (outcome.kind === 'not-granted') return NOT_GRANTED;
  if (outcome.kind === 'taken') return TAKEN;
  if (outcome.kind === 'cycle') {
    return invalid('parentId', 'A folder cannot move under itself or one of its own subfolders.');
  }
  return done(request.folderId);
};
