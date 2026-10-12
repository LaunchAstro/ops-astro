// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The owner's call on chat-made tasks: a task created from a chat card is
// assigned to the person who clicked Create. The card says so before the
// click. The assignment is the existing `task.assign`, to the reader
// `team.list` names (`you`), at the revision the create returned, under an id
// derived from the reply, so it meets that command's own checks and no other
// write is sent. Its body is the clicker every time, so a retry after a reload
// sends the same body whatever the team has become since.
// The operations client is a recorder standing in for the network only
// (`chat-proposal-drawer.tsx`).

import { afterEach, describe, expect, it } from 'vitest';
import {
  ADA,
  answered,
  CONVERSATION,
  CREATE,
  drawer,
  ok,
  REPLY,
  refused,
  type Answer,
} from './chat-proposal-drawer.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const MIA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const member = (personId: string, name: string) => ({ personId, name, availability: null });

async function asked(script: Partial<Parameters<typeof drawer>[0]> = {}) {
  const opened = await drawer({ replies: [answered(CREATE)], ...script });
  track(opened.page);
  await opened.ask('We need the printer booked');
  return opened;
}

const assignee = (assigned: readonly { readonly body: Answer }[]): unknown[] =>
  assigned.map((each) => (each.body['fields'] as Answer)['assignee']);

// eslint-disable-next-line max-lines-per-function -- each assignment case of the card, in the page's order
describe('chat proposal card assignee', () => {
  it('the card says the task is yours, and the click creates then assigns it to the clicker', async () => {
    const { page, click, order, sent } = await asked();
    expect(page.find('[data-proposal="assignee"]')?.textContent).toBe('Assigned to you');
    await click();
    const writes = sent.filter((each) => each.name.startsWith('task.'));
    expect(writes).toStrictEqual([
      {
        name: 'task.create',
        body: {
          fields: { title: 'Book the printer', description: 'Two quotes.' },
          conversationId: CONVERSATION,
        },
        options: { operationId: `task-proposal:${REPLY}` },
      },
      {
        name: 'task.assign',
        body: { recordId: 'new-task-id', fields: { assignee: ADA } },
        options: { operationId: `task-proposal-assign:${REPLY}`, expectedRevision: 1 },
      },
    ]);
    // The create lands first; the team is read for the clicker, then the assignment.
    expect(order.filter((name) => name.startsWith('task.') || name === 'team.list')).toStrictEqual([
      'task.create',
      'team.list',
      'task.assign',
    ]);
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
    expect(page.find('[data-proposal="refusal"]')).toBeNull();
  });

  it('an assignment the server refuses leaves the task made, linked, and says it was not assigned', async () => {
    const because = 'Ask an owner for the right to assign tasks.';
    const { page, click } = await asked({ assigns: [refused('SCOPE_NOT_GRANTED', because)] });
    await click();
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
    expect(page.find('[data-proposal="refusal"]')?.textContent).toContain(
      'The task was created but not assigned',
    );
    expect(page.find('[data-proposal="refusal"]')?.textContent).toContain(because);
    expect(page.find('[data-proposal="send"]')).toBeNull();
  });

  it('an assignment with no answer is offered again, and sends the same create and assignment', async () => {
    const lost: Answer = { unavailable: true, because: 'The network dropped.' };
    const { page, click, sent, assigned } = await asked({ assigns: [lost] });
    await click();
    expect(page.find('[data-proposal="send"]')?.textContent).toBe('Send again');
    await click();
    const writes = sent.filter((each) => each.name.startsWith('task.'));
    expect(writes.map((each) => [each.name, each.options['operationId']])).toStrictEqual([
      ['task.create', `task-proposal:${REPLY}`],
      ['task.assign', `task-proposal-assign:${REPLY}`],
      ['task.create', `task-proposal:${REPLY}`],
      ['task.assign', `task-proposal-assign:${REPLY}`],
    ]);
    expect(assignee(assigned())).toStrictEqual([ADA, ADA]);
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
  });

  it('a retry after a reload, the team changed since, sends the same body under its one id', async () => {
    const lost: Answer = { unavailable: true, because: 'The network dropped.' };
    const live = await drawer({ replies: [answered(CREATE)], assigns: [lost] });
    await live.ask('We need the printer booked');
    await live.click();
    await live.page.unmount();
    const changed = ok({
      ok: true,
      you: ADA,
      people: [member(ADA, 'Ada Lovelace'), member(MIA, 'Mia Chen')],
    });
    const again = await drawer({ kept: { body: CREATE, scope: null }, team: changed });
    track(again.page);
    await again.click();
    expect(again.assigned().map((each) => [each.body, each.options])).toStrictEqual(
      live.assigned().map((each) => [each.body, each.options]),
    );
  });

  it('a team list that cannot be read leaves the task made and says it was not assigned', async () => {
    const { page, click, assigned } = await asked({
      team: refused('NOT_FOUND', 'The team list is for staff.'),
    });
    await click();
    expect(assigned()).toHaveLength(0);
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
    expect(page.find('[data-proposal="refusal"]')?.textContent).toContain(
      'The task was created but not assigned',
    );
  });

  it('a create refused sends no assignment', async () => {
    const { click, assigned } = await asked({
      writes: [refused('SCOPE_NOT_GRANTED', 'Ask an owner for the right to create tasks.')],
    });
    await click();
    expect(assigned()).toHaveLength(0);
  });
});
