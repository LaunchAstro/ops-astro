// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs, the thin slice (#2493 piece 1): the three write commands over the Docs store
// (`core-records/src/docs/store.ts`).
//
// The envelope has asked `docs:write` of the business; the store asks it again once its rows
// are held, so a grant revoked during the wait is `SCOPE_NOT_GRANTED`. A folder or page that is
// not in this business is `NOT_FOUND` on the field that named it, the answer a fabricated id
// gets, so a refusal never says whether another business has it. An update names the version it
// read; a page that has moved on is `VERSION_STALE`, and nothing is overwritten. A `folderId`
// moves the page to that folder of the business, as a save (#2514).

import {
  createDocsFolder,
  createDocsPage,
  DOCS_BODY_LIMIT,
  DOCS_NAME_LIMIT,
  DOCS_TITLE_LIMIT,
  docsBodyOf,
  docsNameOf,
  docsTitleOf,
  subjectsOf,
  updateDocsPage,
} from '../../../core-records/src/index.ts';
import type { DocsWriter, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { Handler } from './handler-types.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

export const invalid = (field: string, fix: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], [fix]));

export const notFound = (field: string, what: string): HandlerOutcome =>
  refused(
    refuseCommand('NOT_FOUND', [field], [`No ${what} of this business carries that identifier.`]),
  );

export const NOT_GRANTED: HandlerOutcome = refused(
  refuseCommand(
    'SCOPE_NOT_GRANTED',
    [],
    ['no live grant covers it', 'ask a holder who may delegate'],
  ),
);

export const NAME_FIX: string = `Send name as text of 1 to ${DOCS_NAME_LIMIT} characters, with no control character.`;
const TITLE_FIX = `Send title as text of 1 to ${DOCS_TITLE_LIMIT} characters, with no control character.`;
const BODY_FIX = `Send body as Markdown text of at most ${DOCS_BODY_LIMIT} characters.`;

export const writerOf = (context: Pick<CommandContext, 'session'>): DocsWriter => ({
  actorId: context.session.actorId,
  subjects: subjectsOf(context.session),
});

export const fileDocsFolder: Handler<'docs.create_folder'> = async (tx, context, request) => {
  const name = docsNameOf(request.name);
  if (name === undefined) return invalid('name', NAME_FIX);
  const made = await createDocsFolder(tx, writerOf(context), {
    name,
    parentId: request.parentId ?? null,
  });
  if (made.kind === 'no-parent') return notFound('parentId', 'folder');
  if (made.kind === 'not-granted') return NOT_GRANTED;
  if (made.kind === 'taken') {
    return refused(
      refuseCommand(
        'UNIQUE_VALUE_TAKEN',
        ['name'],
        ['That folder already holds a folder of this name.'],
      ),
    );
  }
  return applied(null, null, { folderId: made.folderId });
};

export const fileDocsPage: Handler<'docs.create_page'> = async (tx, context, request) => {
  const title = docsTitleOf(request.title);
  if (title === undefined) return invalid('title', TITLE_FIX);
  const body = docsBodyOf(request.body);
  if (body === undefined) return invalid('body', BODY_FIX);
  const made = await createDocsPage(tx, writerOf(context), {
    folderId: request.folderId,
    title,
    body,
  });
  if (made.kind === 'no-folder') return notFound('folderId', 'folder');
  if (made.kind === 'not-granted') return NOT_GRANTED;
  return applied(null, null, { pageId: made.pageId, version: made.version });
};

export async function reviseDocsPage(
  tx: TenantQuery,
  context: CommandContext,
  request: Parameters<Handler<'docs.update_page'>>[2],
): Promise<HandlerOutcome> {
  const expected = request.expectedVersion;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) {
    return invalid('expectedVersion', 'Send expectedVersion as the version number you read.');
  }
  const title = request.title === undefined ? undefined : docsTitleOf(request.title);
  if (request.title !== undefined && title === undefined) return invalid('title', TITLE_FIX);
  const body = request.body === undefined ? undefined : docsBodyOf(request.body);
  if (request.body !== undefined && body === undefined) return invalid('body', BODY_FIX);
  if (title === undefined && body === undefined && request.folderId === undefined) {
    return invalid('body', 'Send a new body, a new title, a folderId, or any of them.');
  }
  const done = await updateDocsPage(tx, writerOf(context), {
    pageId: request.pageId,
    expectedVersion: expected,
    title,
    body,
    folderId: request.folderId,
  });
  if (done.kind === 'no-page') return notFound('pageId', 'page');
  if (done.kind === 'no-folder') return notFound('folderId', 'folder');
  if (done.kind === 'not-granted') return NOT_GRANTED;
  if (done.kind === 'stale') {
    return refused(
      refuseCommand(
        'VERSION_STALE',
        ['expectedVersion'],
        ['The page changed since you opened it. Read it again, then save your change on top.'],
      ),
    );
  }
  return applied(null, null, { pageId: request.pageId.toLowerCase(), version: done.version });
}
