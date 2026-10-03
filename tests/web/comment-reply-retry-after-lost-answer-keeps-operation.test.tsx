// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Comments, type CommentDraft } from '../../apps/web/src/screens/task/Comments.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(unmountAll);

// Sol OW-089.2 criterion 5, retitled by what it proves; its body is Sol's.
it('reselecting the same reply after a lost response retries the original operation', async () => {
  const stored = new Map<string, Record<string, unknown>>();
  const requests: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    // Model the server storing an operation, with the first response lost in transit.
    stored.set(String(body['operationId']), body);
    if (requests.length === 1) throw new TypeError('Response lost after commit');
    return json({ recordId: 'task', revision: 1, detail: { commentId: 'reply' } });
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  function Conversation(): ReactElement {
    const [held, setHeld] = useState<CommentDraft | null>(null);
    return (
      <Comments
        client={client}
        comments={[
          {
            id: 'parent',
            body: 'Parent note',
            audience: 'internal',
            author: 'ada',
            comment_type: 'note',
            posted_at: '2026-10-01T00:00:00Z',
            edited_at: null,
            source: 'app',
            parent: null,
            signal: null,
            own: true,
          },
        ]}
        recordId="task"
        revision={1}
        refusal={null}
        onRefused={() => {}}
        onPosted={() => {}}
        draft={held}
        onDraft={setHeld}
        editing={null}
        onEditing={() => {}}
      />
    );
  }
  const view = await mount(<Conversation />);
  await view.click('[data-comment-act="reply"]');
  await typeInto(view, '#comment-body', 'One reply only');
  await view.click('[data-comment="post"]');
  await tick();
  expect(view.find('[data-comment="unresolved"]')).not.toBeNull();
  await view.click('[data-comment-act="reply"]');
  await view.click('[data-comment="post"]');
  await tick();
  expect(requests).toHaveLength(2);
  expect(requests[1]?.['parentId']).toBe('parent');
  expect(requests[1]?.['body']).toBe('One reply only');
  expect(requests[1]?.['operationId']).toBe(requests[0]?.['operationId']);
  expect(stored.size).toBe(1);
});
