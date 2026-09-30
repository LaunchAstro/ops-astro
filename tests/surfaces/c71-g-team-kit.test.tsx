// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-G on the kit: no mockup surface draws the group list, the member picker
// or the add control, so each is the kit's own: the panel list row (DS-COMP),
// the checkbox (DS-PRIM-8) and the select (DS-PRIM-5). The page draws no
// native checkbox or select of its own.

import { afterEach, expect, it } from 'vitest';
import { TeamPanel } from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';
import { ME, LAUNCH, props } from './team-fixture.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it('C71-G the group list is the kit’s panel rows, the open one selected, unread at the trail', async () => {
  mounted = await mount(<TeamPanel {...props()} />);
  const rows = mounted.all('.tmc__glist > li');
  expect(rows.map((row) => row.className)).toEqual(['lrow lrow--panel', 'lrow lrow--panel']);
  const launch = mounted.find('.tmc__g[data-group="g-launch"]')?.closest('li');
  expect(launch?.querySelector('.lrow__trail .cbadge')?.textContent).toBe('1');

  await mounted.click('.tmc__g[data-group="g-launch"]');
  expect(launch?.getAttribute('data-state')).toBe('selected');
  expect(
    mounted.find('.tmc__g[data-group="g-studio"]')?.closest('li')?.hasAttribute('data-state'),
  ).toBe(false);
});

it('C71-G the member picker is the kit’s checkboxes, each named for its teammate', async () => {
  mounted = await mount(<TeamPanel {...props()} />);
  await mounted.click('.tmc__start');
  const boxes = mounted.all('form.tmc__new [role="checkbox"].check');
  expect(boxes.map((box) => box.getAttribute('aria-label'))).toEqual([
    'Remy Hale',
    'Len Ortiz',
    'Cath Lea',
  ]);
  await mounted.click('form.tmc__new [data-pick="p-len"] [role="checkbox"]');
  expect(
    mounted
      .find('form.tmc__new [data-pick="p-len"] [role="checkbox"]')
      ?.getAttribute('aria-checked'),
  ).toBe('true');
  expect(mounted.find('form.tmc__new input[type="checkbox"]')).toBeNull();
});

it('C71-G adding a member is the kit’s select, labelled for the group', async () => {
  mounted = await mount(
    <TeamPanel {...props({ groups: [{ ...LAUNCH, members: [ME, 'p-remy'] }] })} />,
  );
  await mounted.click('.tmc__g[data-group="g-launch"]');
  const field = mounted.find('form.tmc__adding .field');
  expect(field?.querySelector('.field__label')?.textContent).toBe(`Add to ${LAUNCH.name}`);
  expect(field?.querySelector('.sel .sel__btn')).not.toBeNull();
  expect(mounted.find('form.tmc__adding select')).toBeNull();
});
