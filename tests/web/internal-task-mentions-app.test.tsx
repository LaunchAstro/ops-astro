// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { InternalCommentView } from '../../packages/core-wire/src/index.ts';
import { pathTo } from '../../apps/web/src/routes.ts';
import { draftApp, draftReply, ID } from './projects-draft-app-support.tsx';
import { task } from './task-page-stub.tsx';
import { comment } from './conversation-support.tsx';
import { ADA, PEOPLE, key, response } from './internal-task-mentions-support.tsx';

async function composed(where: 'page' | 'panel') {
  let comments: readonly InternalCommentView[] = [];
  const item = task({
    id: ID,
    key: 'Mention-compose',
    title: 'Mention composition task',
    time: null,
  });
  const row = Object.assign({}, item, {
    actualMinutes: 0,
    estimateMinutes: null,
    statePosition: null,
    waitReason: null,
    awaitingDecision: false,
    agent: null,
    myAgents: [],
    comments: { client: 0, mentions: 0, latest: null },
  });
  return await draftApp({
    path: where === 'page' ? pathTo('agency:task-detail', { key: item.key }) : '/projects/',
    reply: (sent) => {
      if (sent.path === '/person/list') return Promise.resolve(response(PEOPLE));
      if (sent.path === '/task/board')
        return Promise.resolve(response({ ok: true, tasks: [row], viewer: null }));
      if (sent.path === '/task/read')
        return Promise.resolve(response({ ok: true, task: { ...item, comments } }));
      if (sent.path === '/task/comment') {
        comments = [
          comment('stored-mention', 'internal', '2026-10-08T00:00:00Z', String(sent.body['body'])),
        ];
        return Promise.resolve(response({ recordId: ID, revision: item.revision }));
      }
      return Promise.resolve(draftReply(sent));
    },
  });
}

it.each(['page', 'panel'] as const)(
  'real App %s composes a permitted mention through command and authoritative readback',
  async (where) => {
    const app = await composed(where);
    if (where === 'panel') await key(app.view, 'main tr[data-row]', 'Enter');
    const scope = where === 'panel' ? 'panel-' : '';
    const chooser =
      '[data-internal-task-mentions="' +
      scope +
      'comment-mentions"] button[aria-haspopup="listbox"]';
    await key(app.view, chooser, 'ArrowDown');
    await key(app.view, chooser, 'ArrowDown');
    await key(app.view, chooser, 'Enter');
    expect(app.view.text()).toContain('Ada Synthetic');
    const body = '#' + scope + 'comment-body';
    await app.view.type(body, 'Composed permitted internal mention');
    const container = where === 'panel' ? '[data-task-panel]' : 'main';
    await app.view.click(container + ' [data-comment="post"]');
    const posts = app.sent.filter((sent) => sent.path === '/task/comment');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({
      recordId: ID,
      body: 'Composed permitted internal mention',
      audience: 'internal',
      commentType: 'note',
      mentions: [ADA],
      expectedRevision: 4,
    });
    expect(
      app.view.find(container + ' [data-comment-id="stored-mention"] .card__body')?.textContent,
    ).toBe('Composed permitted internal mention');
    expect(app.view.find(container + ' [data-mention-person]')).toBeNull();
    expect(app.sent.some((sent) => /grant|share/u.test(sent.path))).toBe(false);
  },
);
