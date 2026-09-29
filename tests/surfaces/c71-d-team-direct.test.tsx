// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-D, team direct messages in the Team panel: the thread and composer,
// unread derived from the reader's own read marker, the panel opening on the
// first unread conversation without reading it (R36), and the Team tab's
// chip painted with the first frame. The comment command, the refusals for a
// third person, a client and an agent, the no-second-store proof, the audit
// and the isolation crossings are the server's (MP-4-5's comment record).

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Shell,
  TeamPanel,
  newestAt,
  openingThread,
  teamUnread,
  unreadOf,
  type DirectThread,
} from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';
import { ME, THREADS, chip, message, props } from './team-fixture.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const unreadChip = (m: Mounted, id: string): string | null =>
  chip(m, id)?.querySelector('.cbadge')?.textContent ?? null;

const thread = (withPerson: string): DirectThread => {
  const found = THREADS.find((t) => t.with === withPerson);
  if (found === undefined) throw new Error(withPerson);
  return found;
};

async function send(m: Mounted, how: 'button' | 'enter'): Promise<void> {
  if (how === 'button') {
    await m.click('.tmc__conv .composer button[type="submit"]');
    return;
  }
  await act(() => {
    m.host
      .querySelector('.tmc__conv form.composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe("C71-D CS-7.25 select a teammate's thread; unread is derived from last read", () => {
  it('unread is the others’ messages after the reader’s marker; their own never count', () => {
    expect(unreadOf(thread('p-ryan'), ME)).toBe(1);
    expect(unreadOf(thread('p-len'), ME)).toBe(0);
    expect(unreadOf(thread('p-cath'), ME)).toBe(2);
    const mineAfter: DirectThread = {
      with: 'p-len',
      lastRead: '2026-09-28T08:00:00Z',
      messages: [message('m1', ME, '2026-09-28T09:00:00Z')],
    };
    expect(unreadOf(mineAfter, ME)).toBe(0);
    // The marker sits on the message it was moved to: that message is read.
    const atMarker: DirectThread = { ...thread('p-ryan'), lastRead: '2026-09-28T11:47:00Z' };
    expect(unreadOf(atMarker, ME)).toBe(0);
    expect(newestAt(thread('p-ryan'))).toBe('2026-09-28T11:47:00Z');
    expect(newestAt({ with: 'p-x', lastRead: null, messages: [] })).toBeNull();
  });

  it('selecting a teammate with unread opens their thread and moves the marker to its newest message', async () => {
    const p = props({ threads: THREADS });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-person="p-cath"] .tmc__face');
    expect(p.calls.marks).toEqual([['p-cath', '2026-09-28T08:21:00Z']]);
    expect(
      mounted.all('.tmc__conv .msg').map((m) => (m as HTMLElement).dataset['message']),
    ).toEqual(['c1', 'c2']);
  });

  it('selecting a thread with nothing unread moves nothing', async () => {
    const p = props({ threads: THREADS });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-person="p-len"] .tmc__face');
    expect(p.calls.marks).toEqual([]);
    expect(mounted.all('.tmc__conv .msg')).toHaveLength(2);
  });

  it('each teammate’s chip carries their unread count, uncapped, and none at zero', async () => {
    const many: DirectThread = {
      with: 'p-len',
      lastRead: null,
      messages: Array.from({ length: 12 }, (_, i) =>
        message(`n${String(i)}`, 'p-len', `2026-09-28T0${String(i % 10)}:00:00Z`),
      ),
    };
    mounted = await mount(<TeamPanel {...props({ threads: [thread('p-ryan'), many] })} />);
    expect(unreadChip(mounted, 'p-ryan')).toBe('1');
    expect(unreadChip(mounted, 'p-len')).toBe('12');
    expect(unreadChip(mounted, 'p-cath')).toBeNull();
  });
});

describe('C71-D R36 opening selects the first unread thread and marks it read only on a click into it or a send', () => {
  it('opens on the first conversation with anything unread, and reads nothing by opening', async () => {
    expect(openingThread(THREADS, ME)).toBe('p-ryan');
    expect(openingThread([thread('p-len')], ME)).toBeNull();
    const p = props({ threads: THREADS });
    mounted = await mount(<TeamPanel {...p} />);
    expect(chip(mounted, 'p-ryan')?.classList.contains('is-on')).toBe(true);
    expect(mounted.all('.tmc__conv .msg')).toHaveLength(3);
    expect(p.calls.marks).toEqual([]);
    expect(unreadChip(mounted, 'p-ryan')).toBe('1');
  });

  it('a click into the open thread moves the marker', async () => {
    const p = props({ threads: THREADS });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('.tmc__conv .tmc__scroll');
    expect(p.calls.marks).toEqual([['p-ryan', '2026-09-28T11:47:00Z']]);
  });

  it('with nothing unread anywhere the panel opens on nobody', async () => {
    const p = props({ threads: [thread('p-len')] });
    mounted = await mount(<TeamPanel {...p} />);
    expect(mounted.find('.tmc__conv .dp__empty')?.textContent).toBe('Nobody selected.');
    expect(mounted.all('.tmc__strip .is-on')).toHaveLength(0);
  });
});

describe('C71-D CS-7.26 send a direct message', () => {
  it('Send and Enter each send the trimmed words to the teammate, once, and keep the field ready', async () => {
    const p = props({ threads: THREADS });
    mounted = await mount(<TeamPanel {...p} />);
    const field = '.tmc__conv .composer input';
    expect(mounted.host.querySelector(field)?.getAttribute('placeholder')).toBe('Message Ryan');
    expect(mounted.host.querySelector(field)?.getAttribute('aria-label')).toBe('Message Ryan');
    await mounted.type(field, '  Looks right on mobile.  ');
    await send(mounted, 'button');
    await mounted.type(field, 'Ship it');
    await send(mounted, 'enter');
    expect(p.calls.sends).toEqual([
      ['p-ryan', 'Looks right on mobile.'],
      ['p-ryan', 'Ship it'],
    ]);
    expect((mounted.host.querySelector(field) as HTMLInputElement | null)?.value).toBe('');
    expect(document.activeElement).toBe(mounted.host.querySelector(field));
  });

  it('an empty or blank message sends nothing', async () => {
    const p = props({ threads: THREADS });
    mounted = await mount(<TeamPanel {...p} />);
    await send(mounted, 'button');
    await mounted.type('.tmc__conv .composer input', '   ');
    await send(mounted, 'enter');
    expect(p.calls.sends).toEqual([]);
  });

  it('a teammate with no conversation yet can be messaged: the thread starts empty', async () => {
    const none = props({ threads: [] });
    mounted = await mount(<TeamPanel {...none} />);
    await mounted.click('[data-person="p-cath"] .tmc__face');
    expect(mounted.all('.tmc__conv .msg')).toHaveLength(0);
    await mounted.type('.tmc__conv .composer input', 'Hello');
    await send(mounted, 'button');
    expect(none.calls.sends).toEqual([['p-cath', 'Hello']]);
  });
});

describe('C71-D CS-7.42 a new message shows in the open thread and moves the unread chip with no refresh', () => {
  it('the next read’s messages are drawn in place; the counts re-derive and nothing is read for the reader', async () => {
    const p = props({ threads: THREADS });
    mounted = await mount(
      <>
        <Shell {...shell(THREADS)} />
        <TeamPanel {...p} />
      </>,
    );
    expect(tabCount(mounted)).toBe('3');
    const arrived = THREADS.map((t) =>
      t.with === 'p-ryan'
        ? { ...t, messages: [...t.messages, message('r4', 'p-ryan', '2026-09-28T12:00:00Z')] }
        : t,
    );
    await mounted.render(
      <>
        <Shell {...shell(arrived)} />
        <TeamPanel {...p} threads={arrived} />
      </>,
    );
    expect(
      (mounted.all('.tmc__conv .msg').at(-1) as HTMLElement | undefined)?.dataset['message'],
    ).toBe('r4');
    expect(unreadChip(mounted, 'p-ryan')).toBe('2');
    expect(tabCount(mounted)).toBe('4');
    expect(p.calls.marks).toEqual([]);
  });
});

describe("C71-D the Team tab's unread chip is painted at load", () => {
  it('the dock tab carries the sum with the first frame, uncapped, and nothing at zero', async () => {
    mounted = await mount(<Shell {...shell(THREADS)} />);
    expect(teamUnread(THREADS, ME)).toBe(3);
    expect(tabCount(mounted)).toBe('3');
    expect(mounted.find('.dock__tab')?.getAttribute('aria-label')).toBe('Open Team, 3 unread');
    const twelve: DirectThread = {
      with: 'p-len',
      lastRead: null,
      messages: Array.from({ length: 12 }, (_, i) =>
        message(`n${String(i)}`, 'p-len', `2026-09-28T0${String(i % 10)}:00:00Z`),
      ),
    };
    await mounted.render(<Shell {...shell([twelve])} />);
    expect(tabCount(mounted)).toBe('12');
    await mounted.render(<Shell {...shell([thread('p-len')])} />);
    expect(mounted.find('.dock__tab .cbadge')).toBeNull();
    expect(mounted.find('.dock__tab')?.getAttribute('aria-label')).toBe('Open Team');
  });
});

describe('C71-D the thread draws each message as the words written', () => {
  it('a message carrying markup is shown as text, never as markup', async () => {
    const planted = '<img src=x onerror="alert(1)"><b>bold</b>';
    const hostile: DirectThread = {
      with: 'p-ryan',
      lastRead: null,
      messages: [message('h1', 'p-ryan', '2026-09-28T09:00:00Z', planted)],
    };
    mounted = await mount(<TeamPanel {...props({ threads: [hostile] })} />);
    expect(mounted.find('.tmc__conv .msg__text')?.textContent).toBe(planted);
    expect(mounted.find('.tmc__conv img')).toBeNull();
    expect(mounted.find('.tmc__conv .msg__text b')).toBeNull();
  });

  it('each message names who wrote it and when, the reader’s own as You', async () => {
    mounted = await mount(<TeamPanel {...props({ threads: THREADS })} />);
    const metas = mounted.all('.tmc__conv .msg__meta b').map((b) => b.textContent);
    expect(metas).toEqual(['Ryan Hale', 'You', 'Ryan Hale']);
    expect(mounted.find('.tmc__conv .msg time')?.getAttribute('datetime')).toBe(
      '2026-09-28T09:12:00Z',
    );
  });
});

function shell(threads: readonly DirectThread[]): Parameters<typeof Shell>[0] {
  return {
    face: 'agency',
    rail: [],
    here: '/',
    title: 'Home',
    dock: [{ id: 'team', label: 'Team', open: false, count: teamUnread(threads, ME) }],
    onDockTab: () => null,
    seated: false,
    children: null,
  };
}

const tabCount = (m: Mounted): string | null =>
  m.host.querySelector('.dock__tab .cbadge')?.textContent ?? null;
