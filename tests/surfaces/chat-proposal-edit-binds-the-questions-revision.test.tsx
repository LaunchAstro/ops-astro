// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The chat path's piece 2, its edit (designs/chat-path-slice.md): an edit a
// reply proposes applies to the chat's own task at the revision read before
// its question was sent (Sol F4), kept in the tab by the reply's message id,
// so a task changed since is refused as stale and nothing newer is
// overwritten, and a retry or a reload sends the same attempt with the same
// payload (Sol F5, F6). The click reads nothing. The recorder stands in for
// the network only (`chat-proposal-drawer.tsx`).
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { STALE_EDIT, UNBOUND_EDIT } from '../../apps/web/src/assistant/proposals.ts';
import {
  answered,
  CONVERSATION,
  drawer,
  EDIT,
  GRANT,
  REPLY,
  refused,
  TASK,
} from './chat-proposal-drawer.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

// eslint-disable-next-line max-lines-per-function -- each edit leg of the card, in the page's order
describe('chat proposal edit', () => {
  it('edit applies to the chat’s own task only, at the revision read before its question was sent', async () => {
    const { page, order, ask, click, writes } = await drawer({ replies: [answered(EDIT)] }, true);
    track(page);
    await ask('Rename this for the second draft');
    // The task is read before the question leaves, never after the answer.
    expect(
      order.filter((name) => name === 'task.read' || name === 'conversation.start'),
    ).toStrictEqual(['task.read', 'conversation.start']);
    expect(page.find('[data-proposal="send"]')?.textContent).toBe('Apply to this task');
    expect(writes()).toHaveLength(0);
    await click();
    expect(writes()).toStrictEqual([
      {
        name: 'task.update',
        body: { recordId: TASK.id, fields: { title: 'Spring brief, second draft' } },
        options: { operationId: `task-proposal:${REPLY}`, expectedRevision: 7 },
      },
    ]);
    // The click reads nothing: its revision is the question's.
    expect(order.filter((name) => name === 'task.read')).toHaveLength(1);
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe(`/task/${TASK.id}`);
    // The tab keeps the baseline as ids and a number, no words.
    expect(
      JSON.parse(sessionStorage.getItem(`ops-astro:proposal-baselines:${GRANT}`) ?? ''),
    ).toStrictEqual({
      [REPLY]: { taskId: TASK.id, revision: 7 },
    });
    expect(page.find('[data-proposal="done"]')?.textContent).toContain('Task updated');
  });

  it('a task changed after the question keeps the card’s revision, and the stale refusal applies nothing and offers no click', async () => {
    let revision = 7;
    const { page, ask, click, writes } = await drawer(
      {
        replies: [answered(EDIT)],
        revision: () => revision,
        writes: [refused('VERSION_STALE', 'Read the task again.')],
      },
      true,
    );
    track(page);
    await ask('Rename this for the second draft');
    // Someone saves newer work on the task before the click.
    revision = 8;
    await click();
    expect(writes().map((each) => each.options['expectedRevision'])).toStrictEqual([7]);
    expect(page.find('[data-proposal="refusal"]')?.textContent).toBe(STALE_EDIT);
    expect(page.find('[data-proposal="send"]')).toBeNull();
    expect(page.find('[data-proposal="task"]')).toBeNull();
  });

  it('an edit whose click got no answer is sent again with the same operation id and revision, even once the task has moved', async () => {
    let revision = 7;
    const { page, ask, click, writes } = await drawer(
      {
        replies: [answered(EDIT)],
        revision: () => revision,
        writes: [{ unavailable: true, because: 'The network dropped.' }],
      },
      true,
    );
    track(page);
    await ask('Rename this for the second draft');
    await click();
    // The first edit may have landed: the task is now at the next revision.
    revision = 8;
    expect(page.find('[data-proposal="send"]')?.textContent).toBe('Send again');
    await click();
    const [first, second] = writes();
    expect(second).toStrictEqual(first);
    expect(second?.options).toStrictEqual({
      operationId: `task-proposal:${REPLY}`,
      expectedRevision: 7,
    });
  });

  it('after a reload a kept edit card sends the write its live card would, from the baseline kept in the tab', async () => {
    const live = await drawer({ replies: [answered(EDIT)] }, true);
    await live.ask('Rename this for the second draft');
    await live.page.unmount();
    const again = await drawer({
      kept: { body: EDIT, scope: { kind: 'task', id: TASK.id } },
      revision: () => 9,
    });
    track(again.page);
    await again.click();
    expect(again.writes()).toStrictEqual([
      {
        name: 'task.update',
        body: { recordId: TASK.id, fields: { title: 'Spring brief, second draft' } },
        options: { operationId: `task-proposal:${REPLY}`, expectedRevision: 7 },
      },
    ]);
  });

  it('a kept edit card with no baseline in this tab applies nothing and says why', async () => {
    // A tab kept for the session, its edit proposed somewhere no baseline was kept.
    sessionStorage.setItem(
      `ops-astro:drawer-tabs:${GRANT}`,
      JSON.stringify({ selected: CONVERSATION, tabs: [CONVERSATION] }),
    );
    const again = await drawer({ kept: { body: EDIT, scope: { kind: 'task', id: TASK.id } } });
    track(again.page);
    await again.click();
    expect(again.writes()).toHaveLength(0);
    expect(again.page.find('[data-proposal="refusal"]')?.textContent).toBe(UNBOUND_EDIT);
    expect(again.page.find('[data-proposal="send"]')).toBeNull();
  });
});
