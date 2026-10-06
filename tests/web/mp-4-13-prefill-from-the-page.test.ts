// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-13 (DN-02, DOCK T-17): a task-filing door prefills the draft from the
// page: category, owner, estimate, due +7 or +3, and the client from the
// page's scope or none, with the sentence that admits each guess.

import { describe, expect, it } from 'vitest';
import { doorContext, prefillOf } from '../../apps/web/src/screens/task/task-prefill.ts';

// 22:00 UTC on 6 October is 08:00 on 7 October on the business's clock.
const NOW = new Date('2026-10-06T22:00:00Z');

describe('MP-4-13 any task-filing control prefills the draft from the page', () => {
  it('the category comes from the door, else its board, else Admin said as a fallback', () => {
    expect(prefillOf({ from: 'Inbox', category: 'seo', channel: 'ads' }, NOW).category).toBe('seo');
    const routed = prefillOf({ from: 'Inbox', channel: 'ads', channelLabel: 'Paid ads' }, NOW);
    expect(routed.category).toBe('paid-ads');
    expect(routed.why).toContain('the Paid ads board');
    const none = prefillOf({ from: 'Inbox' }, NOW);
    expect(none.category).toBe('admin');
    expect(none.why).toBe(
      'Nothing here to guess from: due in 7 days, and the category fell back to Admin; no owner guessed.',
    );
  });

  it('a category outside the nine is not taken from the door', () => {
    expect(prefillOf({ from: 'Inbox', category: 'Hacking' }, NOW).category).toBe('admin');
  });

  it('the estimate is the category’s usual size', () => {
    expect(prefillOf({ from: 'Inbox', category: 'seo' }, NOW).estimate).toBe(240);
    expect(prefillOf({ from: 'Inbox', category: 'paid-ads' }, NOW).estimate).toBe(60);
    expect(prefillOf({ from: 'Inbox' }, NOW).estimate).toBe(30);
  });
});

describe('MP-4-13 the draft’s due, owner and client come from the page', () => {
  it('due is a week out on the business’s day, three days when the move is urgent', () => {
    expect(prefillOf({ from: 'Inbox' }, NOW).due).toBe('2026-10-14');
    const urgent = prefillOf({ from: 'Inbox', urgent: true, subject: 'Checkout down' }, NOW);
    expect(urgent.due).toBe('2026-10-10');
    expect(urgent.why).toBe(
      'Guessed from “Checkout down”, the move being flagged urgent: due in 3 days, pulled in because this move is flagged urgent, and the category fell back to Admin; no owner guessed.',
    );
  });

  it('the owner is the person the door names, or nobody', () => {
    const named = prefillOf({ from: 'Inbox', owner: { id: 'p-1', name: 'Len' } }, NOW);
    expect(named.owner).toEqual({ id: 'p-1', name: 'Len' });
    expect(named.why).toContain('; owner Len.');
    expect(prefillOf({ from: 'Inbox' }, NOW).owner).toBeNull();
  });

  it('the client comes from the page’s scope, or is left empty; never a fixed client', () => {
    expect(prefillOf({ from: 'Inbox', clientId: 'c-9' }, NOW).clientId).toBe('c-9');
    expect(prefillOf({ from: 'Inbox' }, NOW).clientId).toBeNull();
  });

  it('a door’s data-new-task attributes are its context', () => {
    const door = document.createElement('button');
    door.dataset['newTask'] = 'Checkout down';
    door.dataset['newTaskChannel'] = 'site';
    door.dataset['newTaskLabel'] = 'Site health';
    door.dataset['newTaskUrgent'] = '';
    door.dataset['newTaskClient'] = 'c-9';
    door.dataset['newTaskOwner'] = 'p-1';
    door.dataset['newTaskOwnerName'] = 'Sam Example';
    expect(doorContext(door)).toEqual({
      from: 'Site health',
      subject: 'Checkout down',
      channel: 'site',
      channelLabel: 'Site health',
      category: undefined,
      urgent: true,
      clientId: 'c-9',
      owner: { id: 'p-1', name: 'Sam Example' },
    });
  });
});
