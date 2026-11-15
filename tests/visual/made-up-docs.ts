// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up Docs for the width-and-theme harness (#2493): a folder with a subfolder and one
// page, and that page's Markdown. Typed against the wire contract, like made-up-api.ts, and
// test side only. Every name is made up.

import type { DocsPageResult, DocsTreeResult } from '../../packages/core-wire/src/index.ts';

export const DOCS_READS: {
  readonly 'docs.tree': DocsTreeResult;
  readonly 'docs.page': DocsPageResult;
} = {
  'docs.tree': {
    ok: true,
    folders: [
      { id: 'f-handbook', name: 'Handbook', parentId: null },
      { id: 'f-onboarding', name: 'Onboarding', parentId: 'f-handbook' },
    ],
    pages: [{ id: 'p-first-week', folderId: 'f-onboarding', title: 'First week', version: 3 }],
  },
  'docs.page': {
    ok: true,
    document: {
      id: 'p-first-week',
      folderId: 'f-onboarding',
      title: 'First week',
      body: '# Welcome\n\nRead the **handbook** first, then:\n\n- meet the team\n- set up your desk',
      version: 3,
      updatedAt: '2026-11-15T00:00:00.000Z',
    },
  },
};
