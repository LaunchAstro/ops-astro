// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { pathTo } from '../../apps/web/src/routes.ts';
import { draftApp, draftTab } from './projects-draft-app-support.tsx';
import { BODY, compose, world } from './p05-comment-recovery-support.tsx';
import {
  PERSON,
  OTHER,
  assignmentWorld,
  assignmentApp,
  chooseAssignment,
  retryAssignment,
} from './p05-assignment-recovery-support.tsx';

it('actual App assignment retries the same retained operation after write refusal', async () => {
  const storage = draftTab();
  const server = assignmentWorld();
  const app = await assignmentApp(server, storage);
  await chooseAssignment(app, 'page', PERSON);
  const original = server.writes[0]?.body;
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, raw) => {
    if (key === 'ops-astro.assignment-attempts') throw new Error('Write refused');
    set(key, raw);
  };
  await retryAssignment(app);
  expect(server.writes).toHaveLength(2);
  expect(server.writes[1]?.body).toEqual(original);
  expect(server.applications).toHaveLength(1);
  expect(app.view.text()).toMatch(/cleanup|could not.*clear/iu);
  await retryAssignment(app);
  expect(server.writes).toHaveLength(2);
});

it('actual App durably empty assignment cleanup unlocks after write-then-throw without redispatch', async () => {
  const storage = draftTab();
  const server = assignmentWorld('none');
  const app = await assignmentApp(server, storage);
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, raw) => {
    set(key, raw);
    if (key === 'ops-astro.assignment-attempts') throw new Error('Write answer refused');
  };
  await chooseAssignment(app, 'page', PERSON);
  expect(server.writes).toHaveLength(1);
  expect(server.applications).toHaveLength(1);
  await chooseAssignment(app, 'page', OTHER);
  expect(server.writes).toHaveLength(2);
  expect(server.applications).toHaveLength(2);
  expect(server.writes[1]?.body['operationId']).not.toBe(server.writes[0]?.body['operationId']);
});

it('actual App comment explicitly retries the complete retained envelope after write refusal', async () => {
  const storage = draftTab();
  const server = world();
  const app = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: server.reply,
  });
  await compose(app.view);
  const before = app.sent.filter((sent) => sent.path === '/task/comment');
  expect(before).toHaveLength(1);
  const original = before[0]?.body;
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, raw) => {
    if (key === 'ops-astro.comment-attempts') throw new Error('Write refused');
    set(key, raw);
  };
  await app.view.click('main [data-comment="post"]');
  const after = app.sent.filter((sent) => sent.path === '/task/comment');
  expect(after).toHaveLength(2);
  expect(after[1]?.body).toEqual(original);
  expect(app.view.text()).toContain('recovery copy could not be cleared');
  await app.view.click('main [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(2);
});

it('actual App durably empty comment cleanup permits the next draft after write-then-throw', async () => {
  const storage = draftTab();
  const server = world();
  const app = await draftApp({
    storage,
    path: pathTo('agency:task-detail', { key: 'Recovery-comment' }),
    reply: server.reply,
  });
  await compose(app.view);
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, raw) => {
    set(key, raw);
    if (key === 'ops-astro.comment-attempts') throw new Error('Write answer refused');
  };
  await app.view.click('main [data-comment="post"]');
  expect(app.sent.filter((sent) => sent.path === '/task/comment')).toHaveLength(2);
  expect(app.view.text()).not.toContain('recovery copy could not be cleared');
  await app.view.type('#comment-body', BODY + ' next');
  await app.view.click('main [data-comment="post"]');
  const posts = app.sent.filter((sent) => sent.path === '/task/comment');
  expect(posts).toHaveLength(3);
  expect(posts[2]?.body['operationId']).not.toBe(posts[1]?.body['operationId']);
});
