// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import {
  editedMentions,
  type MentionBinding,
} from '../../apps/web/src/screens/task/mention-bindings.ts';
it('the caret distinguishes deleting the first duplicate occurrence from deleting the second', () => {
  const before = '@Sam Lee @Sam Lee ';
  const bindings: readonly MentionBinding[] = [
    { id: 'first', name: 'Sam Lee', start: 0, end: 8 },
    { id: 'second', name: 'Sam Lee', start: 9, end: 17 },
  ];
  expect(editedMentions(before, '@Sam Lee ', bindings, ['Sam Lee'], 0).map((b) => b.id)).toEqual([
    'second',
  ]);
  expect(editedMentions(before, '@Sam Lee ', bindings, ['Sam Lee'], 9).map((b) => b.id)).toEqual([
    'first',
  ]);
});
