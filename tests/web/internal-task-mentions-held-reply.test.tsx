// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { comment } from './conversation-support.tsx';
import {
  ADA,
  Harness,
  mentionAda,
  open,
  response,
  transport,
} from './internal-task-mentions-support.tsx';

it('an unknown reply retries its held parent and audience after that message disappears from All', async () => {
  const server = transport();
  let calls = 0;
  server.answers.comment = () =>
    ++calls === 1
      ? Promise.reject(new Error('Lost reply answer'))
      : Promise.resolve(response({ recordId: 'task-one', revision: 9 }));
  const message = comment('parent-note', 'internal', '2026-10-08T00:00:00Z');
  const view = await open({ client: server.client, comments: [message] });
  await view.click('[role="tab"][id$="all"]');
  await view.click('[data-comment-id="parent-note"] [data-comment-act="reply"]');
  await mentionAda(view);
  await view.type('#comment-body', 'Held reply');
  await view.click('[data-comment="post"]');
  expect(server.posts()[0]?.body).toMatchObject({
    parentId: 'parent-note',
    audience: 'internal',
    mentions: [ADA],
    expectedRevision: 4,
  });
  await view.render(<Harness client={server.client} revision={9} comments={[]} />);
  expect(view.find('#comment-body')).toHaveProperty('value', 'Held reply');
  expect(view.find('#comment-body')).toHaveProperty('disabled', true);
  expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', false);
  await view.click('[data-comment="post"]');
  expect(server.posts()).toHaveLength(2);
  expect(server.posts()[1]?.body).toEqual(server.posts()[0]?.body);
});
