// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-10 on the kit: each teammate's face is the kit's large person avatar
// (DS-PRIM-16, the team card: an accent ring when on, dashed when away) and
// the name's door is the kit's door mark (DS-PRIM-17). Placed, never redrawn:
// the page's own avatar and door rules are gone.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TeamPanel } from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';
import { chip, props } from './team-fixture.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const face = (m: Mounted, id: string): Element | null =>
  chip(m, id)?.querySelector('.tmc__face .av') ?? null;

it('MP-7-10 faces on the kit: the large person avatar, dashed when away, ringed when on', async () => {
  mounted = await mount(<TeamPanel {...props()} />);
  const remy = face(mounted, 'p-remy');
  expect(remy?.className).toBe('av av--person-large');
  expect(remy?.textContent).toBe('RH');
  expect(face(mounted, 'p-len')?.className).toBe('av av--person-large is-away');

  await mounted.click('[data-person="p-remy"] .tmc__face');
  expect(face(mounted, 'p-remy')?.className).toBe('av av--person-large is-on');
  expect(mounted.all('.tmc__strip .av.is-on')).toHaveLength(1);
  expect(mounted.find('.tmc__av')).toBeNull();
});

it('MP-7-10 the name’s door is the kit’s door mark', async () => {
  mounted = await mount(<TeamPanel {...props()} />);
  const name = chip(mounted, 'p-remy')?.querySelector('a.tmc__n');
  expect(name?.querySelector('.door .icon')).not.toBeNull();
  expect(mounted.find('.tmc__door')).toBeNull();
});

it('MP-7-10 the Team sheet draws no avatar or door of its own', () => {
  const sheet = readFileSync(join(process.cwd(), 'packages/ui/src/styles/10-team.css'), 'utf8');
  expect(sheet).not.toMatch(/\.tmc__av\b|\.tmc__door\b|border-style:\s*dashed/u);
});
