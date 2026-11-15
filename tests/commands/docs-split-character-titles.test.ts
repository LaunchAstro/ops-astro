// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs (#2493 piece 1, criterion 5): a page title holding a split character (an unpaired
// surrogate) is refused `FIELD_VALUE_INVALID` on `title` before any Docs statement runs. The
// text writer would otherwise store it as U+FFFD, a title the person never sent. Folder names
// and bodies are refused the same way. Database-free: the handlers run against a recorder that
// fails the test if a statement reaches it.

import { describe, expect, it } from 'vitest';
import {
  fileDocsFolder,
  fileDocsPage,
  reviseDocsPage,
} from '../../packages/core-commands/src/commands/docs.ts';
import { docsBodyOf, docsNameOf, docsTitleOf } from '../../packages/core-records/src/index.ts';

const SPLIT = 'bad\uD800';
const FOLDER = '00000000-0000-4000-8000-000000000001';
const PAGE = '00000000-0000-4000-8000-000000000002';

const statements: string[] = [];
const tx = {
  businessId: '00000000-0000-4000-8000-0000000000b1',
  query: (sql: string) => {
    statements.push(sql);
    return Promise.resolve([]);
  },
} as never;
const context = {
  session: { actorId: '00000000-0000-4000-8000-0000000000a1', subjects: [] },
} as never;

const refusalOf = (outcome: unknown) =>
  (outcome as { refusal?: { code: string; names: readonly string[] } }).refusal ?? outcome;

describe('a split character is refused before any Docs write', () => {
  it('the title, name and body checks refuse an unpaired surrogate', () => {
    expect([docsTitleOf(SPLIT), docsNameOf(SPLIT), docsBodyOf(SPLIT)]).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect([docsTitleOf('fine \u{1F600}'), docsBodyOf('fine \u{1F600}')]).toStrictEqual([
      'fine \u{1F600}',
      'fine \u{1F600}',
    ]);
  });

  it('docs.create_page and docs.update_page refuse the title FIELD_VALUE_INVALID and run no statement', async () => {
    statements.length = 0;
    const made = await fileDocsPage(tx, context, {
      folderId: FOLDER,
      title: SPLIT,
      body: '',
    } as never);
    const revised = await reviseDocsPage(tx, context, {
      pageId: PAGE,
      expectedVersion: 1,
      title: SPLIT,
    } as never);
    const named = await fileDocsFolder(tx, context, { name: SPLIT } as never);
    for (const [outcome, field] of [
      [made, 'title'],
      [revised, 'title'],
      [named, 'name'],
    ] as const) {
      expect(refusalOf(outcome), field).toMatchObject({
        code: 'FIELD_VALUE_INVALID',
        names: [field],
      });
    }
    expect(statements).toStrictEqual([]);
  });
});
