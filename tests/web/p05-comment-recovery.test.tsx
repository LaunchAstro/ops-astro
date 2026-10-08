// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { draftApp, draftTab, ID } from './projects-draft-app-support.tsx';
import { pathTo } from '../../apps/web/src/routes.ts';
import {
  ADA,
  key,
  response,
  refusal,
  deferredResponse,
} from './internal-task-mentions-support.tsx';
import { BODY, PARENT, world, compose } from './p05-comment-recovery-support.tsx';

it('actual App retains unknown reply identity when current rights withhold its result', async () => {
  const server = world();
  const app = await draftApp({
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: server.reply,
  });
  await compose(app.view);
  expect(app.view.text()).toContain('This comment may already have been stored');
  server.revoke();
  await app.view.click('main [data-comment="post"]');
  const posts = app.sent.filter((sent) => sent.path === '/task/comment');
  expect(posts).toHaveLength(2);
  expect(posts[1]?.body).toEqual(posts[0]?.body);
  expect(posts[0]?.body).toMatchObject({
    body: BODY,
    mentions: [ADA],
    parentId: PARENT,
    expectedRevision: 4,
  });
  expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(app.view.text()).toContain('This comment may already have been stored');
  expect(app.view.find('#comment-body')).toHaveProperty('disabled', true);
  server.renew();
  server.advance();
  await app.view.click('main [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')[2]?.body).toEqual(posts[0]?.body);
  expect(app.view.find('#comment-body')).toHaveProperty('value', '');
  await app.view.type('#comment-body', 'Fresh comment after reconciliation');
  await app.view.click('main [data-comment="post"]');
  const fresh = app.sent.filter((sent) => sent.path === '/task/comment')[3]?.body;
  expect(fresh).toMatchObject({ body: 'Fresh comment after reconciliation', expectedRevision: 9 });
  expect(fresh?.['operationId']).not.toEqual(posts[0]?.body['operationId']);
  expect(fresh?.['parentId']).toBeUndefined();
});

it('actual App with failed persistence keeps the reply and sends nothing until custody can be kept', async () => {
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
    reply: server.reply,
  });
  await compose(app.view);
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(0);
  expect(app.view.find('#comment-body')).toHaveProperty('value', BODY);
  expect(app.view.text()).toContain('No new comment was sent');
  blocked = false;
  await app.view.click('main [data-comment="post"]');
  const attempt = app.sent.find((sent) => sent.path === '/task/comment')?.body;
  expect(attempt).toMatchObject({
    body: BODY,
    parentId: PARENT,
    mentions: [ADA],
    expectedRevision: 4,
  });
  const copies = Array.from({ length: storage.length }, (_, i) =>
    storage.getItem(storage.key(i) ?? ''),
  );
  expect(
    copies.some((raw) => raw?.includes(String(attempt?.['operationId'])) && raw.includes(BODY)),
  ).toBe(true);
});

it('actual App does not draw or replay another person’s durable reply', async () => {
  const server = world();
  const storage = draftTab();
  const first = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: server.reply,
  });
  await compose(first.view);
  await first.view.unmount();
  storage.setItem(
    'ops-astro.session',
    JSON.stringify({ businessKey: 'alpha', email: 'other-person@example.test' }),
  );
  const other = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: server.reply,
  });
  expect(other.view.text()).not.toContain(BODY);
  expect(other.view.find('#comment-body')).toHaveProperty('value', '');
  expect(other.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(0);
});

it('actual App sign-out removes the held reply and a delayed answer cannot write it back', async () => {
  const server = world();
  let release: ((answer: Response) => void) | undefined;
  const delayed = new Promise<Response>((done) => {
    release = done;
  });
  const storage = draftTab();
  const app = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: (sent) => (sent.path === '/task/comment' ? delayed : server.reply(sent)),
  });
  await compose(app.view);
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(1);
  const copies = () =>
    Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i) ?? ''));
  expect(copies().some((raw) => raw?.includes(BODY))).toBe(true);
  await app.view.click('.appbar .who__trigger');
  await app.view.click('.who__menu button[role="menuitem"]');
  expect(app.view.find('#signin-email')).not.toBeNull();
  expect(copies().some((raw) => raw?.includes(BODY))).toBe(false);
  if (release === undefined) throw new Error('No delayed comment request');
  release(response({ recordId: ID, revision: 4 }));
  await new Promise<void>((done) => {
    queueMicrotask(done);
  });
  expect(copies().some((raw) => raw?.includes(BODY))).toBe(false);
  expect(app.view.text()).not.toContain(BODY);
});

it('a fresh actual App task-read denial draws no held words and renewed task-read recovers the exact reply', async () => {
  const server = world();
  const storage = draftTab();
  const first = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: server.reply,
  });
  await compose(first.view);
  const original = first.sent.find((sent) => sent.path === '/task/comment')?.body;
  await first.view.unmount();
  const denied = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: (sent) =>
      sent.path === '/task/read'
        ? Promise.resolve(refusal('SCOPE_NOT_GRANTED'))
        : server.reply(sent),
  });
  expect(denied.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(denied.view.text()).not.toContain(BODY);
  expect(denied.view.find('#comment-body')).toBeNull();
  expect(denied.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(0);
  await denied.view.unmount();
  const renewed = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: server.reply,
  });
  expect(renewed.view.find('#comment-body')).toHaveProperty('value', BODY);
  await renewed.view.click('main [data-comment="post"]');
  expect(renewed.sent.find((sent) => sent.path === '/task/comment')?.body).toEqual(original);
});

it('same-owner App transport replacement preserves the exact attempt and ignores an older success', async () => {
  const server = world();
  const older = deferredResponse();
  const retry = deferredResponse();
  let posts = 0;
  const app = await draftApp({
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: (sent) =>
      sent.path === '/task/comment'
        ? ++posts === 1
          ? older.promise
          : retry.promise
        : server.reply(sent),
  });
  await compose(app.view);
  const original = app.sent.find((sent) => sent.path === '/task/comment')?.body;
  await app.rebindTransport();
  expect(app.view.find('#comment-body')).toHaveProperty('value', BODY);
  expect(app.view.find('main [data-comment="post"]')).toHaveProperty('disabled', false);
  await app.view.click('main [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')[1]?.body).toEqual(original);
  await act(() => {
    older.resolve(response({ recordId: ID, revision: 4 }));
  });
  expect(app.view.find('#comment-body')).toHaveProperty('value', BODY);
  expect(app.view.find('main [data-comment="post"]')).toHaveProperty('disabled', true);
  await act(() => {
    retry.resolve(response({ recordId: ID, revision: 4 }));
  });
  expect(app.view.find('#comment-body')).toHaveProperty('value', '');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(2);
});

it('simultaneous actual App page and panel share one busy operation and one explicit retry', async () => {
  const server = world();
  const delayed = deferredResponse();
  let posts = 0;
  const app = await draftApp({
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: (sent) =>
      sent.path === '/task/comment' && ++posts === 1 ? delayed.promise : server.reply(sent),
  });
  await compose(app.view);
  const original = app.sent.find((sent) => sent.path === '/task/comment')?.body;
  await app.view.click('main [data-panel-door="reply"]');
  expect(app.view.find('#panel-comment-body')).toHaveProperty('value', BODY);
  expect(app.view.find('[data-task-panel] [data-comment="post"]')).toHaveProperty('disabled', true);
  await app.view.click('[data-task-panel] [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(1);
  await act(() => {
    delayed.resolve(new Response('lost answer', { status: 503 }));
  });
  expect(app.view.find('[data-task-panel] [data-comment="post"]')).toHaveProperty(
    'disabled',
    false,
  );
  await app.view.click('[data-task-panel] [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')[1]?.body).toEqual(original);
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(2);
});

it('actual App reload into panel reconciles the original page reply once rights return', async () => {
  const server = world();
  const storage = draftTab();
  const first = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: server.reply,
  });
  await compose(first.view);
  const original = first.sent.find((sent) => sent.path === '/task/comment')?.body;
  await first.view.unmount();
  const next = await draftApp({ storage, path: '/projects/', reply: server.reply });
  expect(next.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(0);
  await key(next.view, 'main tr[data-row]', 'Enter');
  expect(next.view.find('#panel-comment-body')).toHaveProperty('value', BODY);
  expect(next.view.text()).toContain('This comment may already have been stored');
  await next.view.click('[data-task-panel] [data-comment="post"]');
  const posts = next.sent.filter((sent) => sent.path === '/task/comment');
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toEqual(original);
  expect(next.view.find('#panel-comment-body')).toHaveProperty('value', '');
});

it.each(['Independent unsent panel words', 'Page words being submitted'])(
  'actual App settles only the submitted host draft and preserves unsent panel words %s',
  async (panelWords) => {
    const server = world();
    const delayed = deferredResponse();
    const app = await draftApp({
      path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
      reply: (sent) => (sent.path === '/task/comment' ? delayed.promise : server.reply(sent)),
    });
    await app.view.click('main [data-panel-door="reply"]');
    await app.view.type('#comment-body', 'Page words being submitted');
    await app.view.type('#panel-comment-body', panelWords);
    expect(app.view.find('#comment-body')).toHaveProperty('value', 'Page words being submitted');
    expect(app.view.find('#panel-comment-body')).toHaveProperty('value', panelWords);
    await app.view.click('main [data-comment="post"]');
    expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(1);
    expect(app.sent.find((sent) => sent.path === '/task/comment')?.body).toMatchObject({
      body: 'Page words being submitted',
    });
    await act(() => {
      delayed.resolve(response({ recordId: ID, revision: 4 }));
    });
    expect(app.view.find('#comment-body')).toHaveProperty('value', '');
    expect(app.view.find('#panel-comment-body')).toHaveProperty('value', panelWords);
    expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(1);
  },
);
