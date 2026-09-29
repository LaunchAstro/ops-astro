// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3, part two: the kit's marks. Named after the supporting checklist's
// components (chip, marker, status pill, tooltip) and the catalogue entries the
// line "every primitive is built here once" brings with them.

import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import {
  Avatar,
  AvatarStack,
  Chip,
  Count,
  Countdown,
  Divider,
  DoorMark,
  Index,
  Link,
  Marker,
  StatusLine,
  StatusMark,
  Term,
} from '../../packages/ui/src/kit/marks.tsx';
import { mount, type Mounted } from './mount.tsx';

// Node's URL, not the document's: jsdom replaces the global one.
const root = fileURLToPath(new NodeURL('../..', import.meta.url));
const sheet = readFileSync(`${root}packages/ui/src/styles/2-primitives.css`, 'utf8');
const rule = (selector: string): string => {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(sheet)?.[1] ?? '';
};
const html = (element: ReactElement): string => renderToStaticMarkup(element);

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it('MP-1-3 chip with its variants', async () => {
  expect(html(<Chip>Retainer</Chip>)).toBe('<span class="chip chip--outline">Retainer</span>');
  expect(html(<Chip kind="soft">8 open</Chip>)).toContain('class="chip chip--soft"');
  expect(html(<Chip tone="bad">Overdue</Chip>)).toContain('class="chip chip--outline is-bad"');
  let removed = false;
  mounted = await mount(
    <Chip
      kind="filter"
      name="Owner"
      value="Account lead"
      onRemove={() => {
        removed = true;
      }}
    />,
  );
  expect(mounted.find('.chip__x')?.getAttribute('aria-label')).toBe(
    'Remove the filter Owner Account lead',
  );
  await mounted.click('.chip__x');
  expect(removed).toBe(true);
  // DR-29: chips are pills everywhere, filter tags included.
  expect(rule('.chip')).toMatch(/border-radius:\s*var\(--radius-pill\)/u);
  expect(rule('.chip--filter')).not.toMatch(/border-radius/u);
  expect(rule('.chip--suggestion:hover')).toMatch(/border-color:\s*var\(--accent\)/u);
  // The one pill: the unused Hub pill class is gone.
  expect(sheet).not.toMatch(/\.u-pill\b/u);
});

it('MP-1-3 status pill in every tone, never a fill', () => {
  for (const tone of ['ok', 'warn', 'bad', 'info', 'idle'] as const) {
    expect(html(<StatusMark tone={tone}>Word</StatusMark>)).toContain(
      `chip chip--outline is-${tone}`,
    );
    expect(rule(`.chip.is-${tone},\n.smark.is-${tone}`)).not.toMatch(/background/u);
  }
  expect(
    html(
      <StatusMark tone="ok" look="text">
        Connected
      </StatusMark>,
    ),
  ).toBe('<span class="smark is-ok">Connected</span>');
  expect(
    html(
      <StatusMark tone="warn" look="line">
        Waiting
      </StatusMark>,
    ),
  ).toBe(
    '<span class="smark is-warn"><span class="sline is-warn" aria-hidden="true"></span>Waiting</span>',
  );
  expect(html(<StatusLine tone="info" node />)).toContain('class="snode is-info"');
  expect(rule('.sline')).toMatch(/width:\s*2px;[^}]*height:\s*11px/su);
});

it('MP-1-3 marker with its variants', () => {
  expect(html(<Marker look="section">This week</Marker>)).toBe(
    '<span class="marker u-tag">This week</span>',
  );
  expect(html(<Marker look="key">Owner</Marker>)).toBe('<span class="keytag">Owner</span>');
  expect(html(<Marker look="stamp">Edited</Marker>)).toBe('<span class="stamp">Edited</span>');
  expect(html(<Marker look="kind">Agent</Marker>)).toContain('class="kind"');
  expect(html(<Index name="Period" value="July" />)).toContain(
    '<span class="index__k">Period</span>',
  );
  expect(html(<Countdown minutesLeft={42} />)).toBe('<span class="ttl is-soon">42 min left</span>');
  expect(html(<Countdown minutesLeft={180} />)).toBe('<span class="ttl">3 h left</span>');
  expect(html(<Countdown minutesLeft={0} />)).toBe('<span class="ttl is-expired">Expired</span>');
  expect(rule('.u-tag::before')).toMatch(/content:\s*''/u);
});

it('MP-1-3 tooltip on hover and on keyboard focus', async () => {
  mounted = await mount(<Term tip="Hours logged this month">Burn</Term>);
  const term = mounted.find('.term');
  const tip = mounted.find('[role="tooltip"]');
  // The explanation is a real element the word is described by, and the word takes focus.
  expect(term?.getAttribute('tabindex')).toBe('0');
  expect(term?.getAttribute('aria-describedby')).toBe(tip?.id);
  expect(tip?.textContent).toBe('Hours logged this month');
  expect(sheet).toMatch(
    /\.term:hover \.term__tip,\s*\.term:focus-visible \.term__tip\s*\{\s*display:\s*block/u,
  );
  expect(rule('.term__tip')).toMatch(/background:\s*var\(--void\)/u);
  expect(rule('.term__tip')).toMatch(/max-width:\s*260px/u);
});

it('MP-1-3 count, avatar, door mark, link and divider', () => {
  // A count of nothing draws nothing.
  expect(html(<Count n={0} label="unread" />)).toBe('');
  expect(html(<Count n={3} label="unread" />)).toBe(
    '<span class="cbadge" aria-label="3 unread">3</span>',
  );
  expect(html(<Count n={3} label="unread" look="corner" />)).toContain(
    'class="cbadge cbadge--corner"',
  );
  // People are round, clients square (DR-34), and each is named.
  expect(html(<Avatar name="Account Lead" />)).toBe(
    '<span class="av av--person" role="img" aria-label="Account Lead" title="Account Lead">AL</span>',
  );
  expect(html(<Avatar name="Sample Clinic" kind="client" />)).toContain('class="av av--client"');
  expect(rule('.av--person')).toMatch(/border-radius:\s*50%/u);
  expect(rule('.av--client')).not.toMatch(/border-radius/u);
  expect(html(<AvatarStack people={[{ name: 'A B', here: true }, { name: 'C D' }]} />)).toContain(
    'class="av av--person is-here"',
  );
  expect(html(<DoorMark to="external" />)).toContain('lucide-square-arrow-out-up-right');
  const out = html(
    <Link href="https://example.org" door="external">
      Search Console
    </Link>,
  );
  expect(out).toContain('target="_blank"');
  expect(out).toContain('rel="noopener noreferrer"');
  expect(html(<Link look="door" href="/task/T-1" label="Open the task" />)).toContain(
    'aria-label="Open the task"',
  );
  expect(html(<Divider />)).toBe('<hr class="rule"/>');
  expect(html(<Divider look="vertical" />)).toContain('role="separator"');
  expect(rule('.door')).toMatch(/opacity:\s*0\.62/u);
});
