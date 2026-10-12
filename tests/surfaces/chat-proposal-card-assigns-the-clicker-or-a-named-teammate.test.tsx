// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The owner's call on chat-made tasks: a task created from a chat card is
// assigned to the person who clicked Create, unless the reply's block names
// someone else on the team. The card shows who it goes to before the click.
// A name that matches no one person on the team (someone of another business,
// a client's own login, a made-up name, or two people sharing it) falls back
// to the clicker, in the same words each time, so the card never tells one
// case from another. The names are matched against `team.list` alone, the
// business's own staff, and nothing else is looked up. The assignment is the
// existing `task.assign` at the revision the create returned, so it meets
// that command's own checks and no other write is sent.
// The operations client is a recorder standing in for the network only
// (`chat-proposal-drawer.tsx`).

import { afterEach, describe, expect, it } from 'vitest';
import { NOT_ON_TEAM } from '../../apps/web/src/assistant/assignees.ts';
import {
  ADA,
  answered,
  block,
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
const SAM_ONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SAM_TWO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLEO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const member = (personId: string, name: string) => ({ personId, name, availability: null });

/** This business's staff: the clicker, Mia, and two people called Sam. */
const TEAM: Answer = ok({
  ok: true,
  you: ADA,
  people: [
    member(ADA, 'Ada Lovelace'),
    member(MIA, 'Mia Chen'),
    member(SAM_ONE, 'Sam Park'),
    member(SAM_TWO, 'Sam Ito'),
  ],
});

/** Every active member, the client's own login Cleo included: never asked by the card. */
const PERSONS: Answer = ok({
  ok: true,
  persons: [
    { personId: ADA, name: 'Ada Lovelace' },
    { personId: CLEO, name: 'Cleo Client' },
  ],
});

const naming = (assignee: string): string =>
  block(JSON.stringify({ action: 'create', title: 'Book the printer', assignee }));

async function asked(body: string, script: Partial<Parameters<typeof drawer>[0]> = {}) {
  const opened = await drawer({
    replies: [answered(body)],
    team: TEAM,
    persons: PERSONS,
    ...script,
  });
  track(opened.page);
  await opened.ask('We need the printer booked');
  return opened;
}

const assignee = (assigned: readonly { readonly body: Answer }[]): unknown[] =>
  assigned.map((each) => (each.body['fields'] as Answer)['assignee']);

// eslint-disable-next-line max-lines-per-function -- each assignee case of the card, in the page's order
describe('chat proposal card assignee', () => {
  it('names no one: the card says it is yours, and the click creates then assigns the task to the clicker', async () => {
    const { page, click, order, sent } = await asked(CREATE);
    expect(page.find('[data-proposal="assignee"]')?.textContent).toBe('Assigned to you');
    expect(page.find('[data-proposal="assignee-note"]')).toBeNull();
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
    // The create lands first; the assignment follows it, after it answered.
    expect(order.filter((name) => name.startsWith('task.'))).toStrictEqual([
      'task.create',
      'task.assign',
    ]);
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
    expect(page.find('[data-proposal="refusal"]')).toBeNull();
  });

  it('names a teammate: the card shows them, and the click assigns the task to them', async () => {
    const { page, click, assigned } = await asked(naming('Mia Chen'));
    expect(page.find('[data-proposal="assignee"]')?.textContent).toBe('Assigned to Mia Chen');
    expect(page.find('[data-proposal="assignee-note"]')).toBeNull();
    await click();
    expect(assignee(assigned())).toStrictEqual([MIA]);
  });

  it('a first name that is one teammate’s, in any case, is that teammate', async () => {
    const { page, click, assigned } = await asked(naming('  mia '));
    expect(page.find('[data-proposal="assignee"]')?.textContent).toBe('Assigned to Mia Chen');
    await click();
    expect(assignee(assigned())).toStrictEqual([MIA]);
  });

  it.each([
    ['someone of another business', 'Zed Outsider'],
    ['a made-up name', 'Nobody Atall'],
    ['the client’s own login, a member who is not staff', 'Cleo Client'],
    ['a first name two teammates share', 'Sam'],
  ])(
    'names %s: the card falls back to the clicker in the same plain words, and the click assigns the clicker',
    async (_case, name) => {
      const { page, click, assigned, reads } = await asked(naming(name));
      expect(page.find('[data-proposal="assignee"]')?.textContent).toBe('Assigned to you');
      expect(page.find('[data-proposal="assignee-note"]')?.textContent).toBe(NOT_ON_TEAM);
      // The note never repeats the name, so it reads the same for every case.
      expect(page.find('[data-proposal="card"]')?.textContent).not.toContain(name);
      await click();
      expect(assignee(assigned())).toStrictEqual([ADA]);
      // Only the business's own staff list is read: no person is looked up by name or id.
      const named = reads.map((each) => each.name).filter((each) => each.startsWith('person.'));
      expect(named).toStrictEqual([]);
      expect(reads.filter((each) => each.name === 'team.list').map((each) => each.body)).toEqual(
        reads.filter((each) => each.name === 'team.list').map(() => ({})),
      );
    },
  );

  it('an assignment the server refuses leaves the task made, linked, and says it was not assigned', async () => {
    const because = 'No person of this business with an active membership carries that identifier.';
    const { page, click } = await asked(naming('Mia Chen'), {
      assigns: [refused('NOT_FOUND', because)],
    });
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
    const { page, click, sent, assigned } = await asked(naming('Mia Chen'), { assigns: [lost] });
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
    expect(assignee(assigned())).toStrictEqual([MIA, MIA]);
    expect(page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
  });

  it('a create refused sends no assignment', async () => {
    const { click, assigned } = await asked(CREATE, {
      writes: [refused('SCOPE_NOT_GRANTED', 'Ask an owner for the right to create tasks.')],
    });
    await click();
    expect(assigned()).toHaveLength(0);
  });
});
