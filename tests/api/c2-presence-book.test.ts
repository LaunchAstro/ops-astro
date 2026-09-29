// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 (#471): live presence, the book the live channel keeps it in
// (`apps/api/presence.ts`). A stream's join is a viewing; its end is the
// leaving, at once, with nothing retained and no idle timer. Starting to
// change a field is marked by a session already joined. The book keys by the
// business the session was admitted to; a viewer sees a topic only while
// joined to it, which the live channel authorises at join; a client session
// neither sees staff presence nor is seen. A change is announced as the
// business and topic only, and only when what staff can see has changed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresenceBook, type PresenceSession } from '../../apps/api/presence.ts';

const staff = (sessionId: string, personId: string, name: string): PresenceSession => ({
  sessionId,
  personId,
  name,
  side: 'staff',
});

const client = (sessionId: string, personId: string): PresenceSession => ({
  sessionId,
  personId,
  name: `Client ${personId}`,
  side: 'client',
});

const ADA = staff('s-ada', 'p-ada', 'Ada Admin');
const BEN = staff('s-ben', 'p-ben', 'Ben Builder');
const BEN_OTHER_TAB = staff('s-ben-2', 'p-ben', 'Ben Builder');
const TASK = 'task:t-1';

function book() {
  const announced: string[] = [];
  const presence = new PresenceBook((businessId, topic) => {
    announced.push(`${businessId} ${topic}`);
  });
  return { presence, announced };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('C2 who else is on this page now (CS-7.1)', () => {
  it('each viewer sees the other viewing, and never themselves', () => {
    const { presence } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-a', TASK, BEN);

    expect(presence.seenBy('biz-a', TASK, 's-ada')).toEqual([
      { personId: 'p-ben', name: 'Ben Builder', state: 'viewing', field: null },
    ]);
    expect(presence.seenBy('biz-a', TASK, 's-ben')).toEqual([
      { personId: 'p-ada', name: 'Ada Admin', state: 'viewing', field: null },
    ]);
  });

  it('a person in two tabs is one person, and their own other tab is not someone else', () => {
    const { presence } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-a', TASK, BEN);
    presence.join('biz-a', TASK, BEN_OTHER_TAB);

    expect(presence.seenBy('biz-a', TASK, 's-ada').map((view) => view.personId)).toEqual(['p-ben']);
    expect(presence.seenBy('biz-a', TASK, 's-ben')).toHaveLength(1);
    expect(presence.seenBy('biz-a', TASK, 's-ben-2').map((view) => view.personId)).toEqual([
      'p-ada',
    ]);
  });

  it('a leaving is at once, and nothing is retained once everyone has gone', () => {
    const { presence } = book();
    const adaLeaves = presence.join('biz-a', TASK, ADA);
    const benLeaves = presence.join('biz-a', TASK, BEN);
    expect(presence.held).toBe(2);

    benLeaves();
    expect(presence.seenBy('biz-a', TASK, 's-ada')).toEqual([]);
    adaLeaves();
    adaLeaves();
    expect(presence.held).toBe(0);
  });
});

describe('C2 who is starting to change this task, and which field (CS-7.36)', () => {
  it('a joined session marks the field it is editing, and clears it', () => {
    const { presence } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-a', TASK, BEN);

    expect(presence.mark('biz-a', TASK, 's-ben', 'due')).toBe(true);
    expect(presence.seenBy('biz-a', TASK, 's-ada')).toEqual([
      { personId: 'p-ben', name: 'Ben Builder', state: 'changing', field: 'due' },
    ]);
    expect(presence.mark('biz-a', TASK, 's-ben', null)).toBe(true);
    expect(presence.seenBy('biz-a', TASK, 's-ada')[0]?.state).toBe('viewing');
  });

  it('a person changing in one tab and viewing in another is shown changing', () => {
    const { presence } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-a', TASK, BEN);
    presence.join('biz-a', TASK, BEN_OTHER_TAB);
    presence.mark('biz-a', TASK, 's-ben-2', 'title');

    expect(presence.seenBy('biz-a', TASK, 's-ada')).toEqual([
      { personId: 'p-ben', name: 'Ben Builder', state: 'changing', field: 'title' },
    ]);
  });

  it('a session not joined to the topic marks nothing', () => {
    const { presence, announced } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-a', 'task:t-2', BEN);
    announced.length = 0;

    expect(presence.mark('biz-a', TASK, 's-ben', 'due')).toBe(false);
    expect(presence.mark('biz-a', 'task:t-2', 's-ben', 'due')).toBe(true);
    announced.length = 0;
    expect(presence.mark('biz-b', 'task:t-2', 's-ben', 'due')).toBe(false);
    expect(presence.seenBy('biz-a', TASK, 's-ada')).toEqual([]);
    expect(announced).toEqual([]);
  });
});

describe('C2 presence is advisory: nothing retained, no idle timer', () => {
  it('there is no idle timer: a viewer who does nothing for a day is still there', () => {
    vi.useFakeTimers();
    const { presence } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-a', TASK, BEN);
    presence.mark('biz-a', TASK, 's-ben', 'due');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    expect(presence.seenBy('biz-a', TASK, 's-ada')[0]).toMatchObject({ state: 'changing' });
  });
});

describe('C2 isolation', () => {
  it('another business on the same topic is never seen, marked or announced across', () => {
    const { presence, announced } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-b', TASK, BEN);
    presence.mark('biz-b', TASK, 's-ben', 'due');

    expect(presence.seenBy('biz-a', TASK, 's-ada')).toEqual([]);
    expect(presence.seenBy('biz-b', TASK, 's-ben')).toEqual([]);
    expect(presence.seenBy('biz-a', TASK, 's-ben')).toEqual([]);
    expect(presence.mark('biz-a', TASK, 's-ben', 'title')).toBe(false);
    expect(announced).toEqual(['biz-a task:t-1', 'biz-b task:t-1', 'biz-b task:t-1']);
    // The control: someone else in biz-b sees Ben.
    presence.join('biz-b', TASK, staff('s-cy', 'p-cy', 'Cy'));
    expect(presence.seenBy('biz-b', TASK, 's-cy').map((view) => view.personId)).toEqual(['p-ben']);
  });

  it('a viewer sees a topic only while joined to it, however many are there', () => {
    const { presence } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-a', 'task:t-2', BEN);

    expect(presence.seenBy('biz-a', 'task:t-2', 's-ada')).toEqual([]);
    expect(presence.seenBy('biz-a', TASK, 's-nobody')).toEqual([]);
    presence.join('biz-a', 'task:t-2', ADA);
    expect(presence.seenBy('biz-a', 'task:t-2', 's-ada').map((view) => view.personId)).toEqual([
      'p-ben',
    ]);
  });

  it('two clients of the same business on the same task see nothing of each other or of staff', () => {
    const { presence } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-a', TASK, client('s-c1', 'p-client-1'));
    presence.join('biz-a', TASK, client('s-c2', 'p-client-2'));
    presence.join('biz-a', TASK, BEN);

    expect(presence.seenBy('biz-a', TASK, 's-c1')).toEqual([]);
    expect(presence.seenBy('biz-a', TASK, 's-c2')).toEqual([]);
    expect(presence.seenBy('biz-a', TASK, 's-ada').map((view) => view.personId)).toEqual(['p-ben']);
  });
});

describe('C2 a client session neither sees staff presence nor is seen', () => {
  it('staff marking a field is invisible to a client, and a client marks nothing', () => {
    const { presence, announced } = book();
    presence.join('biz-a', TASK, ADA);
    presence.join('biz-a', TASK, BEN);
    expect(presence.mark('biz-a', TASK, 's-ada', 'due')).toBe(true);
    expect(announced).toHaveLength(3);
    announced.length = 0;
    const leaves = presence.join('biz-a', TASK, client('s-c1', 'p-client-1'));

    expect(presence.seenBy('biz-a', TASK, 's-c1')).toEqual([]);
    expect(presence.mark('biz-a', TASK, 's-c1', 'due')).toBe(false);
    expect(presence.seenBy('biz-a', TASK, 's-ben').map((view) => view.personId)).toEqual(['p-ada']);
    leaves();
    expect(announced).toEqual([]);
  });
});

describe('C2 a change is announced as its business and topic, and only when it changes', () => {
  it('joins, marks and leaves announce once each; a repeat announces nothing', () => {
    const { presence, announced } = book();
    const leaves = presence.join('biz-a', TASK, ADA);
    presence.mark('biz-a', TASK, 's-ada', 'due');
    presence.mark('biz-a', TASK, 's-ada', 'due');
    leaves();
    leaves();

    expect(announced).toEqual(['biz-a task:t-1', 'biz-a task:t-1', 'biz-a task:t-1']);
  });
});
