// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-G, group conversations in the Team panel: the group list under the
// strip, starting a group from a picker of teammates, the same thread and
// composer as a direct message, rename and member changes only where the
// server says the reader may manage, leave for any member, and unread and the
// Team tab's chip counting groups. The commands, the audit, the refusals for
// a non-member, a client and an agent, the membership windows and the
// isolation crossings are the server's (MP-4-5's comment record); these tests
// are the UI half of each.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TeamPanel,
  openingGroup,
  teamUnread,
  type GroupThread,
} from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';
import { LAUNCH, ME, STUDIO, THREADS, message, props } from './team-fixture.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const group = (m: Mounted, id: string): Element | null => m.find(`[data-group="${id}"]`);
const ids = (m: Mounted, selector: string): readonly (string | undefined)[] =>
  m.all(selector).map((el) => (el as HTMLElement).dataset['message']);
const picker = (m: Mounted): readonly string[] =>
  m.all('form.tmc__new input[name="member"]').map((el) => (el as HTMLInputElement).value);

async function startForm(m: Mounted, name: string, members: readonly string[]): Promise<void> {
  await m.click('.tmc__start');
  await m.type('form.tmc__new input[name="name"]', name);
  // One after another, as a person ticks them.
  await members.reduce(
    (before, id) => before.then(() => m.click(`form.tmc__new input[name="member"][value="${id}"]`)),
    Promise.resolve(),
  );
}

describe('C71-G CS-7.41 start a group conversation with chosen teammates and name it', () => {
  it('the picker offers the teammates in the strip and nobody else: never the reader', async () => {
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('.tmc__start');
    expect(picker(mounted)).toEqual(['p-remy', 'p-len', 'p-cath']);
    expect(mounted.find('form.tmc__new')?.textContent).toContain('Remy Hale');
  });

  it('a name and two teammates start it; the name is trimmed and only the chosen are sent', async () => {
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    await startForm(mounted, '  Meridian launch  ', ['p-remy', 'p-cath']);
    await mounted.click('form.tmc__new button[type="submit"]');
    expect(p.calls.groups).toEqual([
      { do: 'start', name: 'Meridian launch', members: ['p-remy', 'p-cath'] },
    ]);
    expect(mounted.find('form.tmc__new')).toBeNull();
  });

  it('without a name, or with fewer than two teammates, nothing starts', async () => {
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    await startForm(mounted, '   ', ['p-remy', 'p-cath']);
    const submit = 'form.tmc__new button[type="submit"]';
    expect((mounted.host.querySelector(submit) as HTMLButtonElement).disabled).toBe(true);
    await mounted.type('form.tmc__new input[name="name"]', 'Pair');
    await mounted.click('form.tmc__new input[name="member"][value="p-cath"]');
    expect((mounted.host.querySelector(submit) as HTMLButtonElement).disabled).toBe(true);
    await mounted.click(submit);
    // Enter in the name field submits the form past the disabled button.
    await act(() => {
      mounted?.host
        .querySelector('form.tmc__new')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(p.calls.groups).toEqual([]);
    await mounted.click('form.tmc__new .tmc__cancel');
    expect(mounted.find('form.tmc__new')).toBeNull();
    expect(p.calls.groups).toEqual([]);
  });
});

describe('C71-G CS-7.41 a group opens in the same thread and composer as a direct message', () => {
  it('the group list sits under the strip with each group’s unread', async () => {
    mounted = await mount(<TeamPanel {...props({ groups: [LAUNCH, STUDIO] })} />);
    const list = mounted.find('.tmc__groups');
    expect(list?.previousElementSibling?.classList.contains('tmc__strip')).toBe(true);
    expect(group(mounted, 'g-launch')?.textContent).toContain('Meridian launch');
    expect(group(mounted, 'g-launch')?.querySelector('.cbadge')?.textContent).toBe('1');
    expect(group(mounted, 'g-studio')?.querySelector('.cbadge')).toBeNull();
  });

  it('selecting a group draws its messages, reads it, and its composer sends to the group', async () => {
    const p = props({ groups: [LAUNCH, STUDIO] });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-group="g-launch"] .tmc__g');
    expect(ids(mounted, '.tmc__conv .thread .msg')).toEqual(['g1', 'g2']);
    expect(p.calls.groups).toEqual([{ do: 'read', id: 'g-launch', upTo: '2026-09-28T10:20:00Z' }]);
    const field = '.tmc__conv .composer input';
    expect(mounted.host.querySelector(field)?.getAttribute('aria-label')).toBe(
      'Message Meridian launch',
    );
    await mounted.type(field, '  On it ');
    await mounted.click('.tmc__conv .composer button[type="submit"]');
    expect(p.calls.groups.at(-1)).toEqual({ do: 'send', id: 'g-launch', body: 'On it' });
    expect(p.calls.sends).toEqual([]);
    expect(mounted.find('.tmc__ghead')?.textContent).toContain('Remy, Cath');
  });

  it('a group with nothing unread reads nothing on selection', async () => {
    const p = props({ groups: [LAUNCH, STUDIO] });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-group="g-studio"] .tmc__g');
    expect(ids(mounted, '.tmc__conv .msg')).toEqual(['s1']);
    expect(p.calls.groups).toEqual([]);
  });
});

describe('C71-G CS-7.41 its creator, the owner or an administrator renames it and changes its members', () => {
  it('a manager renames it, trimmed', async () => {
    const p = props({ groups: [LAUNCH] });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-group="g-launch"] .tmc__g');
    await mounted.click('.tmc__ghead .tmc__rename');
    await mounted.type('form.tmc__renaming input[name="name"]', '   ');
    await act(() => {
      mounted?.host
        .querySelector('form.tmc__renaming')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(p.calls.groups.filter((a) => a.do === 'rename')).toEqual([]);
    await mounted.type('form.tmc__renaming input[name="name"]', ' Launch week ');
    await mounted.click('form.tmc__renaming button[type="submit"]');
    expect(p.calls.groups.at(-1)).toEqual({ do: 'rename', id: 'g-launch', name: 'Launch week' });
  });

  it('a manager removes a member and adds a teammate who is not already one', async () => {
    const p = props({ groups: [LAUNCH] });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-group="g-launch"] .tmc__g');
    expect(mounted.find(`.tmc__ghead [data-member="${ME}"] .tmc__remove`)).toBeNull();
    await mounted.click('.tmc__ghead [data-member="p-cath"] .tmc__remove');
    expect(p.calls.groups.at(-1)).toEqual({
      do: 'members',
      id: 'g-launch',
      add: [],
      remove: ['p-cath'],
    });
    const offered = mounted
      .all('form.tmc__adding select[name="person"] option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(offered).toEqual(['p-len']);
    await mounted.choose('form.tmc__adding select[name="person"]', 'p-len');
    await mounted.click('form.tmc__adding button[type="submit"]');
    expect(p.calls.groups.at(-1)).toEqual({
      do: 'members',
      id: 'g-launch',
      add: ['p-len'],
      remove: [],
    });
  });
});

describe('C71-G CS-7.41 a manager adds only teammates who are not yet members', () => {
  it('Add takes the teammate shown first, or the one chosen', async () => {
    const pair: GroupThread = { ...LAUNCH, members: [ME, 'p-remy'] };
    const p = props({ groups: [pair] });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-group="g-launch"] .tmc__g');
    await mounted.click('form.tmc__adding button[type="submit"]');
    expect(p.calls.groups.at(-1)).toEqual({
      do: 'members',
      id: 'g-launch',
      add: ['p-len'],
      remove: [],
    });
    await mounted.choose('form.tmc__adding select[name="person"]', 'p-cath');
    await mounted.click('form.tmc__adding button[type="submit"]');
    expect(p.calls.groups.at(-1)).toEqual({
      do: 'members',
      id: 'g-launch',
      add: ['p-cath'],
      remove: [],
    });
  });
});

describe('C71-G CS-7.41 a member who may not manage it only reads, writes and leaves', () => {
  it('a member who may not manage it sees no rename, remove or add, and can still leave', async () => {
    const p = props({ groups: [STUDIO] });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-group="g-studio"] .tmc__g');
    expect(mounted.find('.tmc__ghead')).not.toBeNull();
    expect(mounted.find('.tmc__rename')).toBeNull();
    expect(mounted.find('.tmc__remove')).toBeNull();
    expect(mounted.find('form.tmc__adding')).toBeNull();
    await mounted.click('.tmc__ghead .tmc__leave');
    expect(p.calls.groups).toEqual([{ do: 'leave', id: 'g-studio' }]);
  });

  it('with every teammate already a member there is nobody to add', async () => {
    const all: GroupThread = { ...LAUNCH, members: ['p-remy', ME, 'p-cath', 'p-len'] };
    mounted = await mount(<TeamPanel {...props({ groups: [all] })} />);
    await mounted.click('[data-group="g-launch"] .tmc__g');
    expect(mounted.find('.tmc__rename')).not.toBeNull();
    expect(mounted.find('form.tmc__adding')).toBeNull();
  });
});

describe('C71-G a member added later reads from the moment they joined', () => {
  it('the panel draws exactly the messages the read returned: no earlier message, count or placeholder', async () => {
    const joined: GroupThread = {
      ...LAUNCH,
      lastRead: null,
      messages: [message('j1', 'p-remy', '2026-09-28T12:00:00Z', 'Welcome aboard')],
    };
    mounted = await mount(<TeamPanel {...props({ groups: [joined] })} />);
    await mounted.click('[data-group="g-launch"] .tmc__g');
    expect(ids(mounted, '.tmc__conv .msg')).toEqual(['j1']);
    expect(mounted.find('.tmc__conv')?.textContent).not.toMatch(/earlier|Message g[12]/u);
  });
});

describe('C71-G a removed member reads nothing written after removal', () => {
  it('when the read stops returning the group, its thread, composer, list entry and unread go', async () => {
    const p = props({ groups: [LAUNCH, STUDIO] });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-group="g-launch"] .tmc__g');
    expect(ids(mounted, '.tmc__conv .msg')).toEqual(['g1', 'g2']);
    await mounted.render(<TeamPanel {...p} groups={[STUDIO]} />);
    expect(group(mounted, 'g-launch')).toBeNull();
    expect(ids(mounted, '.tmc__conv .msg')).toEqual([]);
    expect(mounted.find('.tmc__conv .composer')).toBeNull();
    expect(mounted.find('.tmc__ghead')).toBeNull();
    expect(mounted.text()).not.toContain('Meridian launch');
  });
});

describe('C71-G group messages arrive live and count as unread (CS-7.42)', () => {
  it('a new message shows in the open group and its unread moves with no refresh', async () => {
    const p = props({ groups: [LAUNCH, STUDIO] });
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-group="g-launch"] .tmc__g');
    const later: GroupThread = {
      ...STUDIO,
      messages: [...STUDIO.messages, message('s2', 'p-len', '2026-09-28T12:05:00Z')],
    };
    const arrived: GroupThread = {
      ...LAUNCH,
      lastRead: '2026-09-28T10:20:00Z',
      messages: [...LAUNCH.messages, message('g3', 'p-remy', '2026-09-28T12:00:00Z')],
    };
    await mounted.render(<TeamPanel {...p} groups={[arrived, later]} />);
    expect(ids(mounted, '.tmc__conv .msg')).toEqual(['g1', 'g2', 'g3']);
    expect(group(mounted, 'g-studio')?.querySelector('.cbadge')?.textContent).toBe('1');
    expect(group(mounted, 'g-launch')?.querySelector('.cbadge')?.textContent).toBe('1');
  });

  it('the Team tab’s figure counts direct and group unread together', () => {
    expect(teamUnread([...THREADS, LAUNCH, STUDIO], ME)).toBe(4);
    expect(teamUnread([STUDIO], ME)).toBe(0);
  });
});

describe('C71-G opening selects the first unread conversation, groups included, without reading it', () => {
  it('with no direct unread, the panel opens on the first group with unread and reads nothing', async () => {
    const quiet = THREADS.filter((t) => t.with === 'p-len');
    const p = props({ threads: quiet, groups: [STUDIO, LAUNCH] });
    mounted = await mount(<TeamPanel {...p} />);
    expect(openingGroup([STUDIO, LAUNCH], ME)).toBe('g-launch');
    expect(group(mounted, 'g-launch')?.querySelector('.tmc__g')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(ids(mounted, '.tmc__conv .msg')).toEqual(['g1', 'g2']);
    expect(p.calls.groups).toEqual([]);
    expect(p.calls.marks).toEqual([]);
  });

  it('a direct conversation with unread comes first', async () => {
    const p = props({ threads: THREADS, groups: [LAUNCH] });
    mounted = await mount(<TeamPanel {...p} />);
    expect(group(mounted, 'g-launch')?.querySelector('.tmc__g')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(ids(mounted, '.tmc__conv .msg')).toEqual(['r1', 'r2', 'r3']);
  });
});
