// SPDX-License-Identifier: AGPL-3.0-only
import { draftApp, draftReply, ID, type Sent } from './projects-draft-app-support.tsx';
import { task } from './task-page-stub.tsx';
import { comment } from './conversation-support.tsx';
import { PEOPLE, key, response, refusal } from './internal-task-mentions-support.tsx';

export const PARENT = '11111111-1111-4111-8111-111111111112';
export const BODY = 'Held mentioned reply after withheld success';
function boardReply(item: ReturnType<typeof task>): Response {
  return response({
    ok: true,
    tasks: [
      {
        ...item,
        actualMinutes: 0,
        statePosition: null,
        waitReason: null,
        awaitingDecision: false,
        comments: { client: 0, mentions: 0, latest: null },
      },
    ],
    viewer: null,
  });
}
export function world() {
  const parent = comment(PARENT, 'internal', '2026-10-08T00:00:00Z', 'Parent note');
  const item = task({
    id: ID,
    key: 'Recovery-comment',
    title: 'Recovery comment task',
    time: null,
  });
  let posts = 0;
  let revoked = false;
  let revision = 4;
  const reply = (sent: Sent): Promise<Response> => {
    if (sent.path === '/person/list') return Promise.resolve(response(PEOPLE));
    if (sent.path === '/task/read')
      return Promise.resolve(
        response({ ok: true, task: { ...item, revision, comments: [parent] } }),
      );
    if (sent.path === '/task/board') return Promise.resolve(boardReply(item));
    if (sent.path === '/task/comment') {
      posts += 1;
      if (posts === 1)
        return Promise.resolve(new Response('lost after fixture commit', { status: 503 }));
      return Promise.resolve(
        revoked ? refusal('SCOPE_NOT_GRANTED') : response({ recordId: ID, revision: 4 }),
      );
    }
    return Promise.resolve(draftReply(sent));
  };
  return {
    reply,
    revoke: () => {
      revoked = true;
    },
    renew: () => {
      revoked = false;
    },
    advance: () => {
      revision = 9;
    },
  };
}
export async function compose(view: Awaited<ReturnType<typeof draftApp>>['view']) {
  await view.click('[data-comment-id="' + PARENT + '"] [data-comment-act="reply"]');
  const chooser = '[data-internal-task-mentions] button[aria-haspopup="listbox"]';
  await key(view, chooser, 'ArrowDown');
  await key(view, chooser, 'ArrowDown');
  await key(view, chooser, 'Enter');
  await view.type('#comment-body', BODY);
  await view.click('main [data-comment="post"]');
}
