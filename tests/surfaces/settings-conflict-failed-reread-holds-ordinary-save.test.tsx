// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A four-eyes conflict whose reread fails leaves the person without the value
// they lost to (#880). The ordinary Save must not then write over it with no
// revision at all: it sends nothing and says why. Once a reread answers, the
// conflict shows the other administrator's value and the explicit overwrite
// writes against that revision.

import { beforeEach, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { mount } from './mount.tsx';
import { fourEyesWorld, tick, writesOf } from './settings-four-eyes-world.tsx';

beforeEach(() => {
  window.sessionStorage.clear();
});

it('after a conflict and a failed reread, ordinary Save sends nothing unversioned and says why', async () => {
  const world = fourEyesWorld({ value: 500, revision: 7 });
  const page = await mount(
    <SettingsScreen
      client={world.client()}
      grantKey="alpha:ada:0"
      storage={window.sessionStorage}
    />,
  );
  try {
    await tick();
    world.write = 'stale';
    world.read = 'read-fails';
    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect((page.find('[data-settings="read"]') as HTMLElement | null)?.dataset['outcome']).toBe(
      'unavailable',
    );

    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    expect(writesOf(world), 'an unversioned second write was sent over 999').toHaveLength(1);
    expect(world.server().value).toBe(999);
    const why = page.find('[data-settings="refusal"]')?.textContent ?? '';
    expect(why, 'the held Save said nothing').toMatch(/read again/iu);

    // The reread answers: the conflict is drawn and the overwrite carries revision 8.
    await page.click('[data-settings="read"] button');
    await tick();
    expect(page.find('[data-settings="conflict-server"]')?.textContent).toContain('999');
    await page.click('[data-settings="confirm-four-eyes"]');
    await tick();
    expect(writesOf(world)).toHaveLength(2);
    expect(writesOf(world)[1]?.body['expectedRevision']).toBe(8);
    expect(world.server().value).toBe(1200);
  } finally {
    await page.unmount();
  }
});
