// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #1666: in a chat opened on no task, an edit card applies to a task the chat
// created, and the person picks which. One created task is named on the card
// by its title and key, read live. Two or more make a required pick: Apply is
// disabled until the person picks, nothing is preselected, each row is read
// live by its current title with its key beside it, rows the reader may not
// read are hidden, and the rows are paged 5 at a time in the targets' order,
// reading only the rows shown. The recorder stands in for the network only.

import { afterEach, describe, expect, it } from 'vitest';
import { answered, CREATE, drawer } from './chat-proposal-drawer.tsx';
import {
  editing,
  FIRST,
  landed,
  ONE,
  pick,
  READS,
  rowsOf,
  SECOND,
  sendButton,
  SIX,
  targets,
  taskNow,
  taskReads,
  TWO,
  update,
} from './chat-proposal-picker.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

// eslint-disable-next-line max-lines-per-function -- each leg of the card's pick, in the page's order
describe('chat proposal picker card', () => {
  it('a chat on no task creates a task, then one edit card names it by title and key and the click changes it', async () => {
    const { page, reads, ask, click, writes } = await drawer({
      replies: [answered(CREATE), editing(ONE)],
      tasks: READS,
    });
    track(page);
    await ask('We need the printer booked');
    await click();
    await ask('Make that Friday');
    await landed();
    const named = page.find('[data-proposal="target"]')?.textContent ?? '';
    expect(named).toContain('Book the printer');
    expect(named).toContain('T-31');
    expect(taskReads(reads)).toStrictEqual([FIRST]);
    expect(page.find('[data-proposal="option"]')).toBeNull();
    await click();
    expect(writes().at(-1)).toStrictEqual(update(FIRST, 2));
    expect(page.find('[data-proposal="done"]')?.textContent).toContain('Task updated');
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
  });

  it('two created tasks make the person pick: nothing is chosen and Apply stays disabled until they do', async () => {
    const { page, ask, click, writes } = await drawer({ replies: [editing(TWO)], tasks: READS });
    track(page);
    await ask('Rename it');
    await landed();
    expect(rowsOf(page)).toHaveLength(2);
    const options = page.all('[data-proposal="option"]') as HTMLInputElement[];
    expect(options.map((each) => each.checked)).toStrictEqual([false, false]);
    expect(sendButton(page)?.disabled).toBe(true);
    await click();
    expect(writes()).toHaveLength(0);
    await pick(page, SECOND);
    expect(sendButton(page)?.disabled).toBe(false);
    await click();
    expect(writes()).toStrictEqual([update(SECOND, 5)]);
  });

  it('duplicate titles are told apart by key, and a task renamed since shows its current title', async () => {
    const { page, ask } = await drawer({
      replies: [editing(TWO)],
      tasks: {
        [FIRST]: taskNow(FIRST, 'T-31', 'Book the printer'),
        [SECOND]: taskNow(SECOND, 'T-32', 'Book the printer'),
      },
    });
    track(page);
    await ask('Rename it');
    await landed();
    expect(rowsOf(page)).toHaveLength(2);
    const [first, second] = rowsOf(page);
    expect(first).toContain('T-31');
    expect(second).toContain('T-32');
    expect(first).not.toBe(second);
    const renamed = await drawer({
      replies: [editing(TWO)],
      tasks: { ...READS, [SECOND]: taskNow(SECOND, 'T-32', 'Order the paper, renamed') },
    });
    track(renamed.page);
    await renamed.ask('Rename it');
    await landed();
    expect(rowsOf(renamed.page)[1]).toContain('Order the paper, renamed');
  });

  it('a pick with one task still visible needs the person to pick it', async () => {
    const { page, ask, click, writes } = await drawer({
      replies: [editing(targets(true, [2, SECOND, 5]))],
      tasks: READS,
    });
    track(page);
    await ask('Rename it');
    await landed();
    expect(rowsOf(page)).toHaveLength(1);
    expect((page.find('[data-proposal="option"]') as HTMLInputElement).checked).toBe(false);
    expect(sendButton(page)?.disabled).toBe(true);
    await pick(page, SECOND);
    await click();
    expect(writes()).toStrictEqual([update(SECOND, 5)]);
  });

  it('a task the reader may no longer read is not shown among the rows', async () => {
    const { page, ask } = await drawer({
      replies: [editing(TWO)],
      tasks: {
        ...READS,
        [FIRST]: { ok: false, refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] },
      },
    });
    track(page);
    await ask('Rename it');
    await landed();
    expect(rowsOf(page)).toHaveLength(1);
    expect(rowsOf(page)[0]).toContain('Order the paper');
  });

  it('six created tasks page 5 at a time in order, reading only the rows shown, and paging back reaches the first', async () => {
    const six = targets(true, ...SIX.map((each, at) => [at + 1, each.id, at + 10] as const));
    const { page, reads, ask, click, writes } = await drawer({
      replies: [editing(six)],
      tasks: READS,
    });
    track(page);
    await ask('Rename one');
    await landed();
    expect(taskReads(reads)).toStrictEqual(SIX.slice(0, 5).map((each) => each.id));
    expect(rowsOf(page).map((row) => row.includes(SIX[0]?.title ?? '?'))).toContain(true);
    await page.click('[data-proposal="more"]');
    await landed();
    expect(taskReads(reads).slice(5)).toStrictEqual([SIX[5]?.id]);
    expect(rowsOf(page)).toHaveLength(1);
    expect(rowsOf(page)[0]).toContain('Task number 6');
    await page.click('[data-proposal="earlier"]');
    await landed();
    await pick(page, SIX[0]?.id ?? '');
    await click();
    expect(writes()).toStrictEqual([update(SIX[0]?.id ?? '', 10)]);
  });
});
