// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable consistent-function-scoping -- Sol's proof, kept as written */

import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle, type Mounted } from './mount.tsx';
import { doubleClick, press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '33333333-3333-4333-8333-333333333333';

function gate() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
}

function network(answer: (path: string, body: Record<string, unknown>) => Promise<Response>) {
  const fetch: typeof globalThis.fetch = async (input, init) =>
    await answer(String(input), JSON.parse(String(init?.body ?? '{}')));
  return new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
  });
}

const kept = (body = 'Answer') =>
  Response.json({
    recordId: '',
    revision: 0,
    detail: { conversationId: CONVERSATION },
    reply: { answered: true, messageId: crypto.randomUUID(), body },
  });

async function drawer(client: OperationsClient) {
  return track(
    await mount(
      <AssistantView client={client} route="agency:settings" here="/settings" entry={null} />,
    ),
  );
}

async function ask(page: Mounted, body: string) {
  await page.type('[data-assistant="input"]', body);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

async function rename(page: Mounted, title: string) {
  await doubleClick(page, '[data-chat="chat-1"]');
  await page.type('[data-chat-rename="chat-1"]', title);
  await press(page, '[data-chat-rename="chat-1"]', 'Enter');
  await settle();
}
// Sol OW-098.1 criterion 5, retitled by what it proves; its body is Sol's.
it('a rename during conversation start reaches the stored conversation', async () => {
  const pending = gate();
  let stored = '';
  const client = network(async (path, body) => {
    if (path.endsWith('/conversation/allowance')) return Response.json({}, { status: 503 });
    if (path.endsWith('/conversation/start')) {
      stored = String(body['title']);
      await pending.held;
    }
    if (path.endsWith('/conversation/rename')) stored = String(body['title']);
    return kept();
  });
  const page = await drawer(client);
  await ask(page, 'Start this conversation');
  expect(stored).toBe('Chat 1');
  await rename(page, 'Title chosen during start');
  expect(page.find('[data-chat="chat-1"]')?.textContent).toContain('Title chosen during start');
  pending.release();
  await settle();
  await settle();
  expect(stored, 'the stored title must agree with the successful local rename').toBe(
    'Title chosen during start',
  );
});

// Sol OW-098.2 criterion 5, retitled by what it proves; its body is Sol's.
it('two renames cannot persist in reverse user order', async () => {
  const first = gate();
  let stored = 'Chat 1';
  const client = network(async (path, body) => {
    if (path.endsWith('/conversation/allowance')) return Response.json({}, { status: 503 });
    if (path.endsWith('/conversation/rename')) {
      if (body['title'] === 'Older title') await first.held;
      stored = String(body['title']);
    }
    return kept();
  });
  const page = await drawer(client);
  await ask(page, 'Start');
  await rename(page, 'Older title');
  await rename(page, 'Latest title');
  first.release();
  await settle();
  await settle();
  expect(page.find('[data-chat="chat-1"]')?.textContent).toContain('Latest title');
  expect(stored, 'a delayed older write must not overwrite the latest title').toBe('Latest title');
});

// Sol OW-098.3 criterion 5, retitled by what it proves; its body is Sol's.
it('concurrent replies remain beside the questions they answer', async () => {
  const first = gate();
  const client = network(async (path, body) => {
    if (path.endsWith('/conversation/allowance')) return Response.json({}, { status: 503 });
    if (body['body'] === 'First question') await first.held;
    return kept(`Reply to ${String(body['body'])}`);
  });
  const page = await drawer(client);
  await ask(page, 'Start');
  await ask(page, 'First question');
  await ask(page, 'Second question');
  first.release();
  await settle();
  await settle();
  const lines = page.all('[data-message-role]').map((line) => line.textContent);
  expect(lines).toEqual([
    'Start',
    'Reply to Start',
    'First question',
    'Reply to First question',
    'Second question',
    'Reply to Second question',
  ]);
});
