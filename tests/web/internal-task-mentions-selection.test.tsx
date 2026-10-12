// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { act } from 'react';
import {
  ADA,
  BEA,
  PEOPLE,
  deferredResponse,
  response,
  mentionAda,
  open,
  transport,
} from './internal-task-mentions-support.tsx';

it('keyboard person selection sends structured internal mentions without writing a grant', async () => {
  const server = transport();
  const view = await open({ client: server.client });
  await mentionAda(view);
  expect(view.find('#comment-body')).toHaveProperty('value', '@Ada Synthetic ');
  expect(server.posts()).toHaveLength(0);
  await view.type('#comment-body', '@Ada Synthetic Please check this internal note');
  await view.click('[data-comment="post"]');
  expect(server.posts()).toEqual([
    {
      path: '/api/b/alpha/task/comment',
      body: {
        recordId: 'task-one',
        body: '@Ada Synthetic Please check this internal note',
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
  // Posted, the composer holds no selection: a held one, absent from the
  // emptied body, would draw Clear mentions. Nor does the sent mention carry
  // into the next note, even one that names the same person in text.
  expect(view.find('[data-mention-clear]')).toBeNull();
  await view.type('#comment-body', '@Ada Synthetic named again, not chosen');
  await view.click('[data-comment="post"]');
  expect(server.posts()[1]?.body).toMatchObject({ body: '@Ada Synthetic named again, not chosen' });
  expect(server.posts()[1]?.body).not.toHaveProperty('mentions');
});

it('punctuation around a chosen occurrence preserves its recipient', async () => {
  const server = transport();
  const view = await open({ client: server.client });
  await mentionAda(view);
  await view.type('#comment-body', '(@Ada Synthetic ');
  await view.type('#comment-body', "(@Ada Synthetic)'s note");
  await view.click('[data-comment="post"]');
  expect(server.posts()[0]?.body).toMatchObject({ mentions: [ADA] });
});

it('extending a prefix name requires choosing the longer person', async () => {
  const server = transport();
  server.answers.people = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          persons: [
            { personId: ADA, name: 'Ann' },
            { personId: '00000000-0000-4000-8000-000000000012', name: 'Ann Lee' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
  const view = await open({ client: server.client });
  await view.type('#comment-body', '@Ann');
  await view.click('[role="option"]');
  await view.type('#comment-body', '@Ann Lee');
  expect(view.find('[role="option"]')?.textContent).toBe('@Ann Lee');
  await view.click('[data-comment="post"]');
  expect(server.posts()[0]?.body).not.toHaveProperty('mentions');
});

it('two identical display names bind separate occurrences, and deleting one removes only its id', async () => {
  const server = transport();
  const second = '00000000-0000-4000-8000-000000000012';
  server.answers.people = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          persons: [
            { personId: ADA, name: 'Sam Lee' },
            { personId: second, name: 'Sam Lee' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
  const view = await open({ client: server.client });
  await view.type('#comment-body', '@Sam');
  await view.click('[role="option"]');
  await view.type('#comment-body', '@Sam Lee @Sam');
  await view.click('[role="option"]');
  await view.type('#comment-body', '@Sam Lee ');
  await view.click('[data-comment="post"]');
  expect(server.posts()[0]?.body).toMatchObject({ mentions: [ADA] });
});

it('choosing a longer suggestion retires the shorter recipient whose token it replaces', async () => {
  const server = transport();
  server.answers.people = () =>
    Promise.resolve(
      response({
        ok: true,
        persons: [
          { personId: ADA, name: 'Ann' },
          { personId: BEA, name: 'Ann Lee' },
        ],
      }),
    );
  const view = await open({ client: server.client });
  await view.type('#comment-body', '@Ann');
  await view.click('[role="option"]');
  await view.type('#comment-body', '@Ann L');
  await view.click('[role="option"]');
  expect(view.find('#comment-body')).toHaveProperty('value', '@Ann Lee ');
  await view.click('[data-comment="post"]');
  expect(server.posts()[0]?.body).toMatchObject({ mentions: [BEA] });
});

it.each(['@Ada Synthetic note', '@Bea Synthetic note'])(
  'a recovered draft edited while names load retains only its intact recipient: %s',
  async (body) => {
    const server = transport();
    const held = deferredResponse();
    server.answers.people = () => held.promise;
    const view = await open({
      client: server.client,
      initialDraft: {
        body: '@Ada Synthetic ',
        mentions: [ADA],
        tab: 'internal',
        replyTo: null,
        pending: null,
        stale: null,
      },
    });
    await view.type('#comment-body', body);
    await act(() => held.resolve(response(PEOPLE)));
    if (body.startsWith('@Bea')) {
      expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', true);
      await view.click('[data-mention-clear]');
    } else {
      await view.type('#comment-body', body + '!');
    }
    await view.click('[data-comment="post"]');
    if (body.startsWith('@Bea')) expect(server.posts()[0]?.body).not.toHaveProperty('mentions');
    else expect(server.posts()[0]?.body).toMatchObject({ mentions: [ADA] });
  },
);
