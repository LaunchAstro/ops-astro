// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A group's rename form, already open, closes when the next read says the
// reader may no longer manage the group, and the rename is never sent. The
// server refuses it either way; this is the panel not offering it.

import { afterEach, expect, it } from 'vitest';
import { TeamPanel } from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';
import { LAUNCH, next, props } from './team-fixture.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it('an open rename form closes when a refresh says the reader may no longer manage, and sends nothing', async () => {
  const p = props({ groups: [LAUNCH] });
  mounted = await mount(<TeamPanel {...p} />);
  await mounted.click('.tmc__g[data-group="g-launch"]');
  await mounted.click('.tmc__ghead .tmc__rename');
  await mounted.type('form.tmc__renaming input[name="name"]', 'Launch week');
  await mounted.render(<TeamPanel {...next(p, { groups: [{ ...LAUNCH, canManage: false }] })} />);
  expect(mounted.find('form.tmc__renaming')).toBeNull();
  expect(mounted.find('.tmc__rename')).toBeNull();
  expect(p.calls.groups.filter((a) => a.do === 'rename')).toEqual([]);
});
