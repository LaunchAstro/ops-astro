// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #1666: the picker card's click writes only a task the server listed for the
// reply, at the revision kept with it, as the person's own `task.update` with
// operation id `task-proposal:<messageId>`. Malformed targets, or a block that
// names a task itself, draw no card; a forged id never reaches a write; a
// refusal shows the server's reason; the choice is frozen in the tab once
// clicked, so a retry or a reload sends the identical payload. A chat opened
// on a task keeps today's path. The recorder stands in for the network only.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import {
  answered,
  block,
  CONVERSATION,
  drawer,
  GRANT,
  refused,
  REPLY,
  TASK,
} from './chat-proposal-drawer.tsx';
import {
  EDIT_REPLY,
  editing,
  FIRST,
  FORGED,
  landed,
  ONE,
  pick,
  READS,
  RENAME,
  SECOND,
  sendButton,
  targets,
  taskReads,
  TWO,
  update,
} from './chat-proposal-picker.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const one = (task: Record<string, unknown>) => ({ pick: false, tasks: [task] });

// eslint-disable-next-line max-lines-per-function -- each guard on the card's one write
describe('chat proposal picker writes only the pick', () => {
  it.each([
    ['no targets at all', undefined, RENAME],
    ['targets that are not an object', 'T-31', RENAME],
    ['a pick that is not a boolean', { pick: 'yes', tasks: TWO['tasks'] }, RENAME],
    ['an empty list', { pick: true, tasks: [] }, RENAME],
    ['a target that is no uuid', one({ n: 1, taskId: 'T-12', revision: 2 }), RENAME],
    ['a target with no revision', one({ n: 1, taskId: FIRST }), RENAME],
    ['a negative revision', one({ n: 1, taskId: FIRST, revision: -1 }), RENAME],
    ['a position of zero', one({ n: 0, taskId: FIRST, revision: 2 }), RENAME],
    ['a fractional position', one({ n: 1.5, taskId: FIRST, revision: 2 }), RENAME],
    ['a key the server never sends', one({ n: 1, taskId: FIRST, revision: 2, title: 'x' }), RENAME],
    ['a position given twice', targets(true, [1, FIRST, 2], [1, SECOND, 5]), RENAME],
    ['a task given twice', targets(true, [1, FIRST, 2], [2, FIRST, 5]), RENAME],
    ['two tasks with no pick', targets(false, [1, FIRST, 2], [2, SECOND, 5]), RENAME],
    ['a block naming the task by number', TWO, '{"action":"edit","task":2,"title":"x"}'],
    ['a block naming the task by id', ONE, `{"action":"edit","taskId":"${FIRST}","title":"x"}`],
  ])('an edit with %s draws no card, reads no task and writes nothing', async (_n, given, json) => {
    const { page, reads, ask, writes } = await drawer({
      replies: [editing(given, json)],
      tasks: READS,
    });
    track(page);
    await ask('Change it');
    await landed();
    expect(page.find('[data-proposal="card"]')).toBeNull();
    expect(taskReads(reads)).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('a row whose id is forged in the page chooses nothing, and Apply stays disabled', async () => {
    const { page, ask, click, writes } = await drawer({ replies: [editing(TWO)], tasks: READS });
    track(page);
    await ask('Rename it');
    await landed();
    page.find(`[data-proposal="option"][value="${SECOND}"]`)?.setAttribute('value', FORGED);
    await pick(page, FORGED);
    expect(sendButton(page)?.disabled).toBe(true);
    await click();
    expect(writes()).toHaveLength(0);
  });

  it('a choice forged in the tab for the reply never reaches a write', async () => {
    sessionStorage.setItem(
      `ops-astro:proposal-choices:${GRANT}`,
      JSON.stringify({ [EDIT_REPLY]: FORGED }),
    );
    const { page, ask, click, writes } = await drawer({ replies: [editing(TWO)], tasks: READS });
    track(page);
    await ask('Rename it');
    await landed();
    await pick(page, SECOND);
    await click();
    expect(writes()).toHaveLength(0);
    expect(page.find('[data-proposal="refusal"]')).not.toBeNull();
  });

  it('a task the person can no longer write is refused on the click with the server’s own reason', async () => {
    const because = 'Ask an owner for write access to this task.';
    const { page, ask, click } = await drawer({
      replies: [editing(ONE)],
      tasks: READS,
      writes: [refused('SCOPE_NOT_GRANTED', because)],
    });
    track(page);
    await ask('Make that Friday');
    await landed();
    await click();
    expect(page.find('[data-proposal="refusal"]')?.textContent).toContain(because);
  });

  it('a stale click shows the server’s own reason and offers no click again', async () => {
    const because = 'Read the task again.';
    const { page, ask, click } = await drawer({
      replies: [editing(ONE)],
      tasks: READS,
      writes: [refused('VERSION_STALE', because)],
    });
    track(page);
    await ask('Make that Friday');
    await landed();
    await click();
    expect(page.find('[data-proposal="refusal"]')?.textContent).toContain(because);
    expect(sendButton(page)).toBeNull();
  });

  it('a retry and a reload send the identical payload, the choice frozen in the tab once clicked', async () => {
    const live = await drawer({
      replies: [editing(TWO)],
      tasks: READS,
      writes: [{ unavailable: true, because: 'The network dropped.' }],
    });
    await live.ask('Rename the second');
    await landed();
    await pick(live.page, SECOND);
    await live.click();
    expect(sendButton(live.page)?.textContent).toBe('Send again');
    await live.click();
    const [first, again] = live.writes();
    expect(first).toStrictEqual(update(SECOND, 5));
    expect(again).toStrictEqual(first);
    expect(
      JSON.parse(sessionStorage.getItem(`ops-astro:proposal-choices:${GRANT}`) ?? ''),
    ).toStrictEqual({ [EDIT_REPLY]: SECOND });
    await live.page.unmount();
    const reloaded = await drawer({
      kept: { body: block(RENAME), scope: null, messageId: EDIT_REPLY, targets: TWO },
      tasks: READS,
    });
    track(reloaded.page);
    await landed();
    const chosen = reloaded.page.find(`[data-proposal="option"][value="${SECOND}"]`);
    expect((chosen as HTMLInputElement | null)?.checked).toBe(true);
    await reloaded.click();
    expect(reloaded.writes()).toStrictEqual([update(SECOND, 5)]);
  });

  it('a kept edit in a chat on no task whose reply carries no targets draws no card', async () => {
    sessionStorage.setItem(
      `ops-astro:drawer-tabs:${GRANT}`,
      JSON.stringify({ selected: CONVERSATION, tabs: [CONVERSATION] }),
    );
    const again = await drawer({ kept: { body: block(RENAME), scope: null } });
    track(again.page);
    await landed();
    expect(again.page.find('[data-proposal="card"]')).toBeNull();
    expect(again.writes()).toHaveLength(0);
  });

  it('a chat opened on a task keeps today’s path: targets beside its reply are ignored', async () => {
    const { page, ask, click, writes } = await drawer(
      { replies: [{ ...answered(block(RENAME)), targets: TWO }], tasks: READS },
      true,
    );
    track(page);
    await ask('Make that Friday');
    await landed();
    expect(page.find('[data-proposal="option"]')).toBeNull();
    expect(sendButton(page)?.textContent).toBe('Apply to this task');
    await click();
    expect(writes()).toStrictEqual([
      {
        name: 'task.update',
        body: { recordId: TASK.id, fields: { title: 'Book the printer for Friday' } },
        options: { operationId: `task-proposal:${REPLY}`, expectedRevision: 7 },
      },
    ]);
  });
});
