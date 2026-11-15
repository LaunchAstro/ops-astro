// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs reads (#2493 piece 2): the business's folder tree, with each page's title and version
// and never a body, and one page with its Markdown body.
//
// Each is `docs:read` on the business (`declared`, its `COMMAND_SURFACE` row): Docs are the
// business's own, so a grant held at one client reads none of it and is refused, as is a person
// holding no `docs:read`. The store filters every statement by the session's business, on top of
// the tables' forced row security, so another business's page is the same `NOT_FOUND` as a
// missing one and its tree names nothing of it.

import { readDocsPage, readDocsTree } from '../../../core-records/src/index.ts';
import { invalid } from '../commands/operands.ts';
import { refuseNotFound } from '../commands/refusal.ts';
import type { ReadRow } from './read-row.ts';

export const DOCS_READS: { readonly [K in 'docs.tree' | 'docs.page']: ReadRow<K> } = {
  'docs.tree': {
    identifiers: [],
    parse: () => ({ ok: true, operands: {} }),
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx) => ({ ok: true, ...(await readDocsTree(tx)) }),
  },
  'docs.page': {
    identifiers: ['pageId'],
    parse: ({ pageId }) =>
      typeof pageId === 'string'
        ? { ok: true, operands: { pageId } }
        : { ok: false, refusal: invalid('pageId', 'Send pageId as the page.') },
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx, _session, { pageId }) => {
      const page = await readDocsPage(tx, pageId);
      return page === undefined ? refuseNotFound(['pageId']) : { ok: true, document: page };
    },
  },
};
