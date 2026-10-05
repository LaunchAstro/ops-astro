// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it } from 'vitest';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { comment, conversing } from './conversation-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(unmountAll);

// Sol OW-093.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('refreshing a task preserves an unsent comment edit', async () => {
  const { view, sent } = conversing([
    comment('m1', 'internal', '2026-09-20T01:00:00.000Z', 'original words', { own: true }),
  ]);
  const seen = await view();
  await seen.click('[data-comment-id="m1"] [data-comment-act="edit"]');
  await typeInto(seen, '[data-comment-edit]', 'unsent revised words');
  await seen.click('[data-refresh="task"]');
  await tick();
  expect(sent).toHaveLength(0);
  expect(seen.host.querySelector<HTMLTextAreaElement>('[data-comment-edit]')?.value).toBe(
    'unsent revised words',
  );
});
