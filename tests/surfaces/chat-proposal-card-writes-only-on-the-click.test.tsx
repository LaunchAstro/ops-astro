// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The chat path's piece 2 (designs/chat-path-slice.md): an agent's reply that
// ends with a task block draws a card, and only the person's click writes.
// Create sends one `task.create` with the conversation as its origin, and the
// card then links the task; a chat on no task draws no edit card (the edit's
// legs: chat-proposal-edit-binds-the-questions-revision.test.tsx). The click's
// operation id is derived from the reply's message id, so a second click, or a
// reload and a click, presents the same attempt (Sol F6) and the server's
// register replays it (proven against Postgres in
// tests/api/chat-proposal-creates-one-task-from-its-conversation.test.ts).
// The operations client is a recorder standing in for the network only
// (`chat-proposal-drawer.tsx`).
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import {
  answered,
  block,
  CONVERSATION,
  CREATE,
  drawer,
  EDIT,
  ok,
  REPLY,
  refused,
  type Answer,
} from './chat-proposal-drawer.tsx';
import { WRITTEN } from './chat-proposal-written.ts';
import { settle } from './mount.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

// eslint-disable-next-line max-lines-per-function -- each create leg of the card, in the page's order
describe('chat proposal card', () => {
  it('draws a create card under the reply’s words, and sends nothing before the click', async () => {
    const { page, sent, ask, writes } = await drawer({ replies: [answered(CREATE)] });
    track(page);
    await ask('We need the printer booked');
    const line = page.find('[data-proposal="card"]')?.closest('[data-message-role]');
    expect(line?.getAttribute('data-message-role')).toBe('ai');
    expect(line?.textContent).toContain('Here is a task for that.');
    // The block is drawn as the card, never as its JSON.
    expect(line?.textContent).not.toContain('```');
    expect(line?.textContent).not.toContain('"action"');
    expect(page.find('[data-proposal="title"]')?.textContent).toBe('Book the printer');
    expect(page.find('[data-proposal="description"]')?.textContent).toBe('Two quotes.');
    expect(page.find('[data-proposal="send"]')?.textContent).toBe('Create task');
    expect(sent.map((each) => each.name)).toStrictEqual(['conversation.start']);
    expect(writes()).toHaveLength(0);
  });

  it('a reply carrying a task block renders a card, never the raw block, and says the task is only proposed until the click', async () => {
    // Gemma's own reply on the M5, which says it set the task up.
    const { page, ask, writes } = await drawer({ replies: [answered(WRITTEN.gemmaRiverbend)] });
    track(page);
    await ask('Please add a task to draft the Riverbend Bakery newsletter');
    expect(writes()).toHaveLength(0);
    const text = page.text();
    expect(text).not.toContain('```');
    expect(text).not.toContain('{"action"');
    expect(page.all('[data-proposal="card"]')).toHaveLength(1);
    expect(page.find('[data-proposal="card"]')?.textContent).toContain('Proposed task');
    expect(page.find('[data-proposal="pending"]')?.textContent).toBe(
      'Only proposed: no task exists until you click Create task.',
    );
  });

  it('one click sends one task.create with the conversation as origin, and the card links the task', async () => {
    const { page, ask, click, writes } = await drawer({ replies: [answered(CREATE)] });
    track(page);
    await ask('We need the printer booked');
    await click();
    expect(writes()).toStrictEqual([
      {
        name: 'task.create',
        body: {
          fields: { title: 'Book the printer', description: 'Two quotes.' },
          conversationId: CONVERSATION,
        },
        options: { operationId: `task-proposal:${REPLY}` },
      },
    ]);
    const link = page.find('[data-proposal="task"]');
    expect(link?.getAttribute('href')).toBe('/task/T-31');
    expect(link?.textContent).toBe('Book the printer');
    expect(page.find('[data-proposal="done"]')?.textContent).toContain('Task created');
    expect(page.find('[data-proposal="pending"]')).toBeNull();
    // Made, the card offers no second click.
    expect(page.find('[data-proposal="send"]')).toBeNull();
  });

  it('a click while the first is out sends nothing more', async () => {
    let resolve: ((value: Answer) => void) | undefined;
    const promise = new Promise<Answer>((settled) => {
      resolve = settled;
    });
    const out = { promise, resolve: (value: Answer) => resolve?.(value) };
    const { page, ask, writes } = await drawer({
      replies: [answered(CREATE)],
      writes: [out.promise],
    });
    track(page);
    await ask('We need the printer booked');
    await page.click('[data-proposal="send"]');
    expect(page.find('[data-proposal="send"]')?.hasAttribute('disabled')).toBe(true);
    await page.click('[data-proposal="send"]');
    out.resolve(ok({ recordId: 'new-task-id', revision: 1, detail: { key: 'T-31' } }));
    await settle();
    expect(writes()).toHaveLength(1);
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
  });

  it('a click with no answer offers it again under the same operation id, so the register replays one task', async () => {
    const lost: Answer = { unavailable: true, because: 'The network dropped.' };
    const { page, ask, click, writes } = await drawer({
      replies: [answered(CREATE)],
      writes: [lost],
    });
    track(page);
    await ask('We need the printer booked');
    await click();
    expect(page.find('[data-proposal="refusal"]')?.textContent).toContain('The network dropped.');
    expect(page.find('[data-proposal="send"]')?.textContent).toBe('Send again');
    await click();
    const ids = writes().map((each) => each.options['operationId']);
    expect(ids).toStrictEqual([`task-proposal:${REPLY}`, `task-proposal:${REPLY}`]);
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
  });

  it('a refused click shows the server’s words and leaves no link', async () => {
    const { page, ask, click } = await drawer({
      replies: [answered(CREATE)],
      writes: [refused('SCOPE_NOT_GRANTED', 'Ask an owner for the right to create tasks.')],
    });
    track(page);
    await ask('We need the printer booked');
    await click();
    expect(page.find('[data-proposal="refusal"]')?.textContent).toContain(
      'Ask an owner for the right to create tasks.',
    );
    expect(page.find('[data-proposal="task"]')).toBeNull();
  });

  it('after a reload the kept reply draws the card again and its click presents the same operation id', async () => {
    const live = await drawer({ replies: [answered(CREATE)] });
    await live.ask('We need the printer booked');
    await live.click();
    // The page goes; the tab's conversation id stays kept for the session.
    await live.page.unmount();
    const again = await drawer({ kept: { body: CREATE, scope: null } });
    track(again.page);
    expect(again.page.find('[data-proposal="title"]')?.textContent).toBe('Book the printer');
    await again.click();
    expect(again.writes()).toStrictEqual(live.writes());
  });

  it('a chat on no task draws no edit card, and the reply’s words show as written', async () => {
    const { page, ask, writes } = await drawer({ replies: [answered(EDIT)] });
    track(page);
    await ask('Rename it');
    expect(page.find('[data-proposal="card"]')).toBeNull();
    expect(page.find('[data-message-role="ai"]')?.textContent).toBe(EDIT);
    expect(writes()).toHaveLength(0);
  });

  it('a malformed block draws no card and its words show exactly as written', async () => {
    const bad = block('{"action":"create","title":"T","assignee":"me"}');
    const { page, ask } = await drawer({ replies: [answered(bad)] });
    track(page);
    await ask('Anything');
    expect(page.find('[data-proposal="card"]')).toBeNull();
    expect(page.find('[data-message-role="ai"]')?.textContent).toBe(bad);
  });
});
