// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-10, the Team panel: the people strip with each teammate's own
// availability, their name as the door to their work, and the reader setting
// their own availability with a reason. One test per supporting checklist
// line; `availability set`'s command, audit and isolation are the server's.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamPanel, teammatesOf } from '../../packages/ui/src/index.ts';
import { press } from './inbox-fixture.tsx';
import { mount, type Mounted } from './mount.tsx';
import { ME, PEOPLE, chip, person, props, unsaid } from './team-fixture.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await mounted?.unmount();
  mounted = undefined;
});

describe('MP-7-10 people strip with away state as a word', () => {
  it('draws each teammate, never the reader, with the word Away beside an away name', async () => {
    mounted = await mount(<TeamPanel {...props()} />);
    const names = mounted.all('.tmc__strip .tmc__n').map((n) => n.textContent.trim());
    expect(names).toEqual(['Remy', 'Len', 'Cath']);
    expect(chip(mounted, ME)).toBeNull();
    const len = chip(mounted, 'p-len');
    expect(len?.classList.contains('tmc__p--away')).toBe(true);
    expect(len?.querySelector('.tmc__away')?.textContent).toBe('Away');
    // The reason is the person's own words, on the face they would message.
    expect(len?.querySelector('.tmc__face')?.getAttribute('aria-label')).toBe(
      'Message Len Ortiz, away: At the Meridian shoot until 2',
    );
  });

  it('a teammate who is in carries no status word and no away ring', async () => {
    mounted = await mount(<TeamPanel {...props()} />);
    const remy = chip(mounted, 'p-remy');
    expect(remy?.classList.contains('tmc__p--away')).toBe(false);
    expect(remy?.querySelector('.tmc__away')).toBeNull();
    expect(remy?.querySelector('.tmc__face')?.getAttribute('aria-label')).toBe('Message Remy Hale');
  });

  it('teammatesOf leaves the reader out and keeps everyone else in order', () => {
    expect(teammatesOf(PEOPLE, ME).map((p) => p.personId)).toEqual(['p-remy', 'p-len', 'p-cath']);
    expect(teammatesOf(PEOPLE, 'p-nobody')).toHaveLength(4);
  });

  it('away with no reason given is the word Away, and no reason is made up for it', async () => {
    const quiet = [PEOPLE[0], PEOPLE[1], unsaid('p-len', 'Len Ortiz'), PEOPLE[3]].filter(
      (p) => p !== undefined,
    );
    mounted = await mount(<TeamPanel {...props({ people: quiet })} />);
    expect(chip(mounted, 'p-len')?.querySelector('.tmc__away')?.textContent).toBe('Away');
    expect(chip(mounted, 'p-len')?.querySelector('.tmc__face')?.getAttribute('aria-label')).toBe(
      'Message Len Ortiz, away',
    );
    await mounted.render(<TeamPanel {...props({ people: [unsaid(ME, 'Sam Reid')] })} />);
    expect(mounted.find('.tmc__me span')?.textContent).toBe('You are away');
  });
});

describe("MP-7-10 a teammate's name opens their work", () => {
  it('the name is a door to their work: plain in place, Shift beside', async () => {
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    const door = '[data-person="p-len"] a.tmc__n';
    expect(mounted.host.querySelector(door)?.getAttribute('href')).toBe('/projects/?person=p-len');
    expect(await press(mounted, door)).toBe(true);
    expect(await press(mounted, door, { shiftKey: true })).toBe(true);
    expect(p.calls.work).toEqual([
      ['p-len', { beside: false }],
      ['p-len', { beside: true }],
    ]);
  });

  it('a press the browser owns is left to it', async () => {
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    const door = '[data-person="p-remy"] a.tmc__n';
    expect(mounted.host.querySelector(door)).not.toBeNull();
    expect(await press(mounted, door, { ctrlKey: true })).toBe(false);
    expect(await press(mounted, door, { metaKey: true })).toBe(false);
    expect(await press(mounted, door, { button: 1 })).toBe(false);
    expect(p.calls.work).toEqual([]);
  });

  it('the face beside the name is a separate control that does not open their work', async () => {
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('[data-person="p-remy"] .tmc__face');
    expect(p.calls.work).toEqual([]);
    expect(chip(mounted, 'p-remy')?.classList.contains('is-on')).toBe(true);
  });

  it('with no view of their work to open, the name is plain text and no door is drawn', async () => {
    const p = props({ work: null });
    mounted = await mount(<TeamPanel {...p} />);
    expect(mounted.find('.tmc__strip a')).toBeNull();
    expect(mounted.find('[data-person="p-len"] .tmc__n')?.textContent).toBe('Len');
    await mounted.click('[data-person="p-len"] .tmc__n');
    expect(p.calls.work).toEqual([]);
  });
});

describe('MP-7-10 the Team panel opens with the people strip and availability', () => {
  it('opens on the strip, the reader’s own availability and an empty conversation room', async () => {
    mounted = await mount(<TeamPanel {...props()} />);
    expect(mounted.all('.tmc__strip [data-person]')).toHaveLength(3);
    expect(mounted.find('.tmc__me')?.textContent).toContain('You are in');
    expect(mounted.find('.tmc__conv .dp__empty')?.textContent).toBe('Nobody selected.');
    expect(mounted.all('.tmc__strip .is-on')).toHaveLength(0);
  });

  it('with no conversations to draw, a face opens nothing and the room stays empty', async () => {
    const p = props({ conversations: null });
    mounted = await mount(<TeamPanel {...p} />);
    expect(mounted.all('.tmc__strip [data-person]')).toHaveLength(3);
    expect(mounted.find('.tmc__strip button')).toBeNull();
    expect(mounted.find('[data-person="p-len"] .tmc__face')?.getAttribute('aria-label')).toBe(
      'Len Ortiz, away: At the Meridian shoot until 2',
    );
    expect(mounted.find('.tmc__conv[data-team="conversations"]')?.childElementCount).toBe(0);
    expect(mounted.find('.tmc__groups')).toBeNull();
    expect(mounted.find('.composer')).toBeNull();
    await mounted.click('[data-person="p-len"] .tmc__face');
    expect(mounted.all('.tmc__strip .is-on')).toHaveLength(0);
    expect(p.calls.marks).toEqual([]);
    // The reader's own availability does not wait on the conversations.
    expect(mounted.find('.tmc__me')?.textContent).toContain('You are in');
  });

  it('selecting a face marks that one teammate, pressed, and only that one', async () => {
    mounted = await mount(<TeamPanel {...props()} />);
    await mounted.click('[data-person="p-remy"] .tmc__face');
    await mounted.click('[data-person="p-cath"] .tmc__face');
    expect(
      mounted.all('.tmc__strip .is-on').map((el) => (el as HTMLElement).dataset['person']),
    ).toEqual(['p-cath']);
    expect(mounted.find('[data-person="p-cath"] .tmc__face')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

describe('MP-7-10 CS-7.27 the person sets their own availability with a reason', () => {
  it('sets Away with the reason in their own words, trimmed, once, naming nobody', async () => {
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('.tmc__me button.tmc__set');
    await mounted.type('.tmc__me input[name="reason"]', '  At the dentist  ');
    await mounted.click('.tmc__me button[type="submit"]');
    expect(p.calls.availability).toEqual([{ away: true, reason: 'At the dentist' }]);
    expect(Object.keys(p.calls.availability[0] ?? {}).toSorted()).toEqual(['away', 'reason']);
    // The form closes; what shows next is what the server answers with.
    expect(mounted.find('.tmc__me input')).toBeNull();
  });

  it('a reason is required: blank or spaces sends nothing', async () => {
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('.tmc__me button.tmc__set');
    await mounted.type('.tmc__me input[name="reason"]', '   ');
    const submit = mounted.find('.tmc__me button[type="submit"]');
    expect(submit?.hasAttribute('disabled')).toBe(true);
    await mounted.click('.tmc__me button[type="submit"]');
    // Enter in the field submits the form without the button: still nothing.
    await act(() => {
      mounted?.host
        .querySelector('form.tmc__me')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(p.calls.availability).toEqual([]);
  });

  it('cancel closes the form and sends nothing', async () => {
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    await mounted.click('.tmc__me button.tmc__set');
    await mounted.type('.tmc__me input[name="reason"]', 'Lunch');
    await mounted.click('.tmc__me button.tmc__cancel');
    expect(mounted.find('.tmc__me input')).toBeNull();
    expect(p.calls.availability).toEqual([]);
  });

  it('while away the reader sees their own reason and can come back in', async () => {
    const away = PEOPLE.map((p) => (p.personId === ME ? person(ME, 'Sam Reid', 'Leave') : p));
    const p = props({ people: away });
    mounted = await mount(<TeamPanel {...p} />);
    expect(mounted.find('.tmc__me')?.textContent).toContain('You are away: Leave');
    await mounted.click('.tmc__me button.tmc__back');
    expect(p.calls.availability).toEqual([{ away: false }]);
  });
});

describe('MP-7-10 never an automatic online or idle state', () => {
  it('time passing changes nothing and no status is drawn that the person did not set', async () => {
    vi.useFakeTimers();
    const p = props();
    mounted = await mount(<TeamPanel {...p} />);
    const before = mounted.host.innerHTML;
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    await mounted.render(<TeamPanel {...p} />);
    expect(mounted.host.innerHTML).toBe(before);
    expect(chip(mounted, 'p-len')?.querySelector('.tmc__away')?.textContent).toBe('Away');
    expect(chip(mounted, 'p-remy')?.querySelector('.tmc__away')).toBeNull();
    expect(p.calls.availability).toEqual([]);
    expect(mounted.text()).not.toMatch(/online|offline|idle|active now/iu);
  });
});
