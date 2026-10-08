// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { ADA, mentionAda, open, transport } from './internal-task-mentions-support.tsx';

it('keyboard person selection sends structured internal mentions without writing a grant', async () => {
  const server = transport();
  const view = await open({ client: server.client });
  await mentionAda(view);
  expect(view.text()).toContain('Ada Synthetic');
  expect(server.posts()).toHaveLength(0);
  await view.type('#comment-body', 'Please check this internal note');
  await view.click('[data-comment="post"]');
  expect(server.posts()).toEqual([
    {
      path: '/api/b/alpha/task/comment',
      body: {
        recordId: 'task-one',
        body: 'Please check this internal note',
        audience: 'internal',
        commentType: 'note',
        mentions: [ADA],
        operationId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 4,
      },
    },
  ]);
  expect(server.requests.map((r) => r.path)).toEqual([
    '/api/b/alpha/person/list',
    '/api/b/alpha/task/comment',
  ]);
  expect(view.find('[data-mention-person]')).toBeNull();
});
