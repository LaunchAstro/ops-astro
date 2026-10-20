// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A comment whose answer was lost stays held, on the page and in the panel,
// while a refusal may hide a stored success. Stop waiting lets go of that one
// attempt by its operation id: every box showing it unlocks with its words,
// and the next Send is a new request. Another task's held comment is kept.
// When the saved copy cannot be rewritten, the attempt is still never sent
// again: the one control left clears the saved copy.
import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { CommentCustodyProvider } from '../../apps/web/src/screens/task/comment-custody-context.tsx';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { store } from './draft-support.tsx';
import { draftReply } from './projects-draft-app-support.tsx';
import { refusal, response } from './internal-task-mentions-support.tsx';
import { task, tick } from './task-page-stub.tsx';

const KEY = 'ops-astro.comment-attempts';
const A = '11111111-1111-4111-8111-11111111111a';
const B = '11111111-1111-4111-8111-11111111111b';
const KEYS: Readonly<Record<string, string>> = { 'Alpha-talk': A, 'Beta-talk': B };
const PAGE = '[data-surface="page"]';
const PANEL_A = '[data-surface="panel-a"]';
const PANEL_B = '[data-surface="panel-b"]';
const ignore = (): void => {};

/** Each task's first comment is lost before it is stored; later ones obey `revoked`. */
function conversationServer() {
  const posts: Record<string, unknown>[] = [];
  const control = { revoked: false };
  const fetch: typeof globalThis.fetch = (url, init) => {
    const path = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    if (path === '/task/read') {
      const id = KEYS[String(body['recordId'])] ?? String(body['recordId']);
      const key = id === A ? 'Alpha-talk' : 'Beta-talk';
      return Promise.resolve(response({ ok: true, task: task({ id, key, comments: [] }) }));
    }
    if (path !== '/task/comment') return Promise.resolve(draftReply({ path, body }));
    posts.push(body);
    if (posts.filter((post) => post['recordId'] === body['recordId']).length === 1)
      return Promise.resolve(new Response('lost before it was stored', { status: 503 }));
    return Promise.resolve(
      control.revoked
        ? refusal('SCOPE_NOT_GRANTED')
        : response({ recordId: body['recordId'], revision: 4 }),
    );
  };
  return { posts, control, fetch };
}

async function conversations(fetch: typeof globalThis.fetch, storage: Storage) {
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const panel = (taskKey: string) => (
    <TaskPanel
      client={client}
      grantKey="alpha:ada"
      opening={{ taskKey, door: 'reply', tab: 'internal' }}
      onChanged={ignore}
      onClose={ignore}
    />
  );
  const view = await mount(
    <CommentCustodyProvider client={client} grantKey="alpha:ada" storage={storage}>
      <div data-surface="page">
        <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="Alpha-talk" />
      </div>
      <div data-surface="panel-a">{panel('Alpha-talk')}</div>
      <div data-surface="panel-b">{panel('Beta-talk')}</div>
    </CommentCustodyProvider>,
  );
  await tick();
  return view;
}

const box = (view: Mounted, surface: string): HTMLTextAreaElement | null =>
  view.find(`${surface} textarea[id$="comment-body"]`) as HTMLTextAreaElement | null;
async function send(view: Mounted, surface: string, words?: string): Promise<void> {
  if (words !== undefined) await view.type(`${surface} textarea[id$="comment-body"]`, words);
  await view.click(`${surface} [data-comment="post"]`);
  await tick();
}
function stopWaiting(view: Mounted, surface: string): HTMLButtonElement | undefined {
  return view
    .all(`${surface} button`)
    .find((one): one is HTMLButtonElement => /stop waiting/iu.test(one.textContent ?? ''));
}

/** Beta's comment and then Alpha's are lost; Alpha's retry is refused. */
async function heldConversations(storage = store()) {
  const server = conversationServer();
  const view = await conversations(server.fetch, storage);
  await send(view, PANEL_B, 'Beta words');
  await send(view, PAGE, 'Alpha words');
  server.control.revoked = true;
  await send(view, PAGE);
  expect(server.posts.map((post) => post['recordId'])).toEqual([B, A, A]);
  expect(server.posts[2]).toEqual(server.posts[1]);
  expect(box(view, PAGE)).toHaveProperty('disabled', true);
  expect(box(view, PANEL_A)).toMatchObject({ disabled: true, value: 'Alpha words' });
  return { server, view, storage, held: String(server.posts[1]?.['operationId']) };
}

it('Stop waiting on a refused comment retry unlocks every box showing it, keeps its words, and the next Send is new', async () => {
  const { server, view, storage, held } = await heldConversations();
  const letGo = stopWaiting(view, PAGE);
  expect(letGo, 'a held comment whose retry was refused offers Stop waiting').toBeDefined();
  await act(() => letGo?.click());
  await tick();
  expect(box(view, PAGE)).toMatchObject({ disabled: false, value: 'Alpha words' });
  expect(box(view, PANEL_A)).toMatchObject({ disabled: false, value: 'Alpha words' });
  expect(box(view, PANEL_B)).toMatchObject({ disabled: true, value: 'Beta words' });
  const saved = storage.getItem(KEY) ?? '';
  expect(saved).not.toContain(held);
  expect(saved).toContain(String(server.posts[0]?.['operationId']));
  server.control.revoked = false;
  await send(view, PAGE);
  expect(server.posts).toHaveLength(4);
  expect(server.posts[3]).toMatchObject({ recordId: A, body: 'Alpha words' });
  expect(server.posts[3]?.['operationId']).not.toBe(held);
});

it('Stop waiting whose saved copy cannot be rewritten sends nothing more until Clear saved copy succeeds', async () => {
  const storage = store();
  const { server, view, held } = await heldConversations(storage);
  const before = storage.getItem(KEY);
  const set = storage.setItem.bind(storage);
  let blocked = true;
  storage.setItem = (name, value) => {
    if (blocked && name === KEY) throw new Error('storage blocked');
    set(name, value);
  };
  await act(() => stopWaiting(view, PAGE)?.click());
  await tick();
  expect(view.find(`${PAGE}`)?.textContent).toContain(
    'This change was let go, but this browser could not clear its saved copy yet.',
  );
  expect(view.find(`${PAGE} [data-comment="post"]`)?.textContent).toBe('Clear saved copy');
  expect(stopWaiting(view, PAGE)).toBeUndefined();
  await view.click(`${PAGE} [data-comment="post"]`);
  await tick();
  expect(server.posts).toHaveLength(3);
  expect(storage.getItem(KEY)).toBe(before);
  expect(box(view, PANEL_B)).toMatchObject({ disabled: true, value: 'Beta words' });
  blocked = false;
  await view.click(`${PAGE} [data-comment="post"]`);
  await tick();
  expect(server.posts).toHaveLength(3);
  expect(storage.getItem(KEY)).not.toContain(held);
  expect(storage.getItem(KEY)).toContain(String(server.posts[0]?.['operationId']));
  expect(view.find(`${PAGE} [data-comment="post"]`)?.textContent).toBe('Send');
  await send(view, PAGE);
  expect(server.posts).toHaveLength(4);
  expect(server.posts[3]?.['operationId']).not.toBe(held);
});
