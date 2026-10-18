// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A task page's comment box is unmounted during a reread while its draft is
// held above it. If the person stops waiting for its held comment from the
// panel meanwhile, and the panel then posts something else, the page's box
// must come back as an unsent draft: its next Send is a new request, never the
// let-go operation again.
import { act, useState, type ReactElement } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Comments, type CommentDraft } from '../../apps/web/src/screens/task/Comments.tsx';
import { CommentCustodyProvider } from '../../apps/web/src/screens/task/comment-custody-context.tsx';
import { mount } from '../surfaces/mount.tsx';
import { store } from './draft-support.tsx';
import { PEOPLE, refusal, response } from './internal-task-mentions-support.tsx';
import { tick } from './task-page-stub.tsx';

const TASK = '11111111-1111-4111-8111-11111111111a';
const PAGE = '[data-surface="page"]';
const PANEL = '[data-surface="panel"]';
const ignore = (): void => {};

/** The first comment is lost, the second refused, the rest stored. */
function conversationServer() {
  const posts: Record<string, unknown>[] = [];
  const answers = ['lost', 'refused', 'ok', 'ok'];
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (String(url).endsWith('/person/list')) return Promise.resolve(response(PEOPLE));
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const answer = answers[posts.length - 1];
    if (answer === 'lost') return Promise.reject(new TypeError('Failed to fetch'));
    if (answer === 'refused') return Promise.resolve(refusal('SCOPE_NOT_GRANTED'));
    return Promise.resolve(response({ recordId: TASK, revision: 5 }));
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { posts, client };
}

/** A page box whose draft is held above it (it can be away), and a panel box, on one custody. */
async function pageAndPanel(client: OperationsClient) {
  const page = { show: (_shown: boolean): void => {} };
  function Surface(props: { readonly scope?: 'panel' }): ReactElement {
    const [draft, setDraft] = useState<CommentDraft | null>(null);
    const [shown, setShown] = useState(true);
    if (props.scope === undefined) page.show = setShown;
    return shown ? (
      <Comments
        {...(props.scope === undefined ? {} : { scope: props.scope })}
        client={client}
        grantKey="alpha:ada"
        recordId={TASK}
        revision={4}
        comments={[]}
        draft={draft}
        onDraft={setDraft}
        refusal={null}
        onRefused={ignore}
        onPosted={ignore}
        editing={null}
        onEditing={ignore}
      />
    ) : (
      <p>Rereading</p>
    );
  }
  const view = await mount(
    <CommentCustodyProvider client={client} grantKey="alpha:ada" storage={store()}>
      <div data-surface="page">
        <Surface />
      </div>
      <div data-surface="panel">
        <Surface scope="panel" />
      </div>
    </CommentCustodyProvider>,
  );
  await tick();
  return { view, page };
}

it('a page box away during Stop waiting and a later panel post does not resend the let-go comment', async () => {
  const { posts, client } = conversationServer();
  const { view, page } = await pageAndPanel(client);
  await view.type(`${PAGE} textarea`, 'Page words');
  await view.click(`${PAGE} [data-comment="post"]`);
  await tick();
  await view.click(`${PAGE} [data-comment="post"]`);
  await tick();
  const letGoId = String(posts[0]?.['operationId']);
  expect(posts.map((post) => post['operationId'])).toEqual([letGoId, letGoId]);
  // The page rereads; its draft, holding the attempt, is kept above the box.
  await act(() => page.show(false));
  const stop = view
    .all(`${PANEL} button`)
    .find((one): one is HTMLButtonElement => /stop waiting/iu.test(one.textContent ?? ''));
  expect(stop, 'the panel offers Stop waiting for the held comment').toBeDefined();
  await act(() => stop?.click());
  await tick();
  await view.type(`${PANEL} textarea`, 'Panel words');
  await view.click(`${PANEL} [data-comment="post"]`);
  await tick();
  expect(posts).toHaveLength(3);
  expect(posts[2]?.['body']).toBe('Panel words');
  await act(() => page.show(true));
  await tick();
  expect(view.find(`${PAGE} [data-comment="let-go"]`)).toBeNull();
  await view.click(`${PAGE} [data-comment="post"]`);
  await tick();
  expect(posts.slice(3).map((post) => post['operationId'])).not.toContain(letGoId);
});
