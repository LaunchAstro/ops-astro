// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-1 (batch 2c1 review): a reply started on the Client tab must not
// follow the person onto the Internal tab. Choosing Internal says the next
// post is an internal note; a client reply that rides along goes to the
// client while Internal shows selected.

import { afterEach, describe, expect, it } from 'vitest';
import { tick } from './task-page-stub.tsx';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { comment, conversing } from './conversation-support.tsx';

afterEach(unmountAll);

describe('REVIEW-2C1-1 reply audience follows the tab chosen', () => {
  it('REVIEW-2C1-1: Reply on a client message, then the Internal tab, posts an internal note with no parentId, not a client reply', async () => {
    const { view, sent } = conversing([
      comment('c1', 'client', '2026-09-21T02:00:00.000Z', 'from the client', {
        signal: 'owed',
      }),
    ]);
    const seen = await view();
    await seen.click('#conversation-tab-client');
    await seen.click('[data-comment-id="c1"] [data-comment-act="reply"]');
    expect(seen.find('[data-comment="replying"]')).not.toBeNull();
    await seen.click('#conversation-tab-internal');
    expect(seen.find('#conversation-tab-internal')?.getAttribute('aria-selected')).toBe('true');
    await typeInto(seen, '#comment-body', 'Only for us.');
    await seen.click('[data-comment="post"]');
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('/task/comment');
    expect(
      sent[0]?.body,
      'Internal is selected, so the post must be an internal note, not a client reply',
    ).toMatchObject({ body: 'Only for us.', audience: 'internal', commentType: 'note' });
    expect(sent[0]?.body).not.toHaveProperty('parentId');
  });
});
