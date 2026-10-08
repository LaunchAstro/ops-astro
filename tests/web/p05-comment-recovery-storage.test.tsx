// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { pathTo } from '../../apps/web/src/routes.ts';
import { draftApp, draftTab, ID } from './projects-draft-app-support.tsx';
import { response, refusal, deferredResponse } from './internal-task-mentions-support.tsx';
import { BODY, compose, world } from './p05-comment-recovery-support.tsx';

it('a confirmed reply whose cleanup fails blocks a new send and retries only durable cleanup', async () => {
  const server = world();
  const storage = draftTab();
  const set = storage.setItem.bind(storage);
  let cleanupBlocked = false;
  storage.setItem = (name, value) => {
    if (cleanupBlocked) throw new Error('cleanup write blocked');
    set(name, value);
  };
  let posts = 0;
  const app = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: (sent) => {
      if (sent.path !== '/task/comment') return server.reply(sent);
      if (++posts === 1) return Promise.resolve(new Response('lost answer', { status: 503 }));
      cleanupBlocked = true;
      return Promise.resolve(response({ recordId: ID, revision: 4 }));
    },
  });
  await compose(app.view);
  await app.view.click('main [data-comment="post"]');
  expect(app.view.find('#comment-body')).toHaveProperty('value', '');
  expect(app.view.text()).toContain('recovery copy could not be cleared');
  await app.view.type('#comment-body', 'Next draft held until cleanup');
  await app.view.click('main [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(2);
  cleanupBlocked = false;
  await app.view.click('main [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(2);
  expect(app.view.find('#comment-body')).toHaveProperty('value', 'Next draft held until cleanup');
  const copies = Array.from({ length: storage.length }, (_, i) =>
    storage.getItem(storage.key(i) ?? ''),
  );
  expect(copies.some((raw) => raw?.includes(BODY))).toBe(false);
});

it('actual App storage-blocked attempt receives a fresh refusal after its first real dispatch', async () => {
  const server = world();
  const storage = draftTab();
  const set = storage.setItem.bind(storage);
  let blocked = true;
  storage.setItem = (name, value) => {
    if (blocked && value.includes(BODY)) throw new Error('storage blocked');
    set(name, value);
  };
  const app = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: (sent) =>
      sent.path === '/task/comment'
        ? Promise.resolve(refusal('SCOPE_NOT_GRANTED'))
        : server.reply(sent),
  });
  await compose(app.view);
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(0);
  expect(app.view.text()).toContain('No new comment was sent');
  blocked = false;
  await app.view.click('main [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(1);
  expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(app.view.text()).not.toContain('This comment may already have been stored');
  expect(app.view.find('main [data-comment="post"]')).toHaveProperty('disabled', true);
  await app.view.click('main [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(1);
});

it.each(['success', 'refused'] as const)(
  'actual App ordinary Refresh consumes a known comment %s after remount',
  async (answer) => {
    const server = world();
    const post = deferredResponse();
    const read = deferredResponse();
    let refreshing = false;
    const app = await draftApp({
      path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
      reply: (sent) => {
        if (sent.path === '/task/comment') return post.promise;
        if (sent.path === '/task/read' && refreshing) return read.promise;
        return server.reply(sent);
      },
    });
    await app.view.type('#comment-body', 'Draft submitted before ordinary Refresh');
    await app.view.click('main [data-comment="post"]');
    refreshing = true;
    await app.view.click('[data-refresh="task"]');
    expect(app.view.find('#comment-body')).toBeNull();
    await act(() => {
      post.resolve(
        answer === 'success'
          ? response({ recordId: ID, revision: 4 })
          : refusal('SCOPE_NOT_GRANTED'),
      );
    });
    expect(app.view.find('#comment-body')).toBeNull();
    refreshing = false;
    const refreshed = await server.reply({ path: '/task/read', body: { recordId: ID } });
    await act(() => {
      read.resolve(refreshed);
    });
    expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(1);
    expect(app.view.text()).not.toContain('This comment may already have been stored');
    if (answer === 'success') {
      expect(app.view.find('#comment-body')).toHaveProperty('value', '');
      expect(app.view.find('#comment-body')).toHaveProperty('disabled', false);
    } else {
      expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
      expect(app.view.find('#comment-body')).toHaveProperty(
        'value',
        'Draft submitted before ordinary Refresh',
      );
      expect(app.view.find('main [data-comment="post"]')).toHaveProperty('disabled', true);
    }
  },
);
