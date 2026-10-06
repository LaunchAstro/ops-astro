// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Criterion 2: an Alpha threshold save whose answer never
// arrived must not lend its operation id or its revision to an explicit save of
// the same value in Bravo, once the same still-mounted screen has moved there.

import { expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { fourEyesWorld, tick, writesOf } from '../surfaces/settings-four-eyes-world.tsx';

const ALPHA: Session = { businessKey: 'alpha', email: 'ada@alpha.local' };
const BRAVO: Session = { businessKey: 'bravo', email: 'ada@alpha.local' };

it('a Bravo save never reuses a lost Alpha intent', async () => {
  window.sessionStorage.clear();
  const sessions = new SessionStore(window.sessionStorage);
  const alpha = fourEyesWorld({ value: 500, revision: 7 });
  const bravo = fourEyesWorld({ value: 500, revision: 3 });

  sessions.set(ALPHA);
  const page = await mount(
    <SettingsScreen
      client={alpha.client('alpha')}
      grantKey={grantKeyOf(sessions.session)}
      storage={window.sessionStorage}
    />,
  );
  try {
    await tick();
    // Alpha's save of 1200 is sent at revision 7 and its answer never arrives.
    alpha.write = 'lost';
    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    const [lost] = writesOf(alpha).map((call) => call.body);
    expect(lost?.['expectedRevision']).toBe(7);

    // The same tab and the same mounted screen move to Bravo.
    sessions.set(BRAVO);
    await page.render(
      <SettingsScreen
        client={bravo.client('bravo')}
        grantKey={grantKeyOf(sessions.session)}
        storage={window.sessionStorage}
      />,
    );
    await tick();
    expect(bravo.sent.some((call) => call.at.endsWith('/settings/read'))).toBe(true);
    expect(bravo.sent.some((call) => call.at.endsWith('/session/capabilities'))).toBe(true);

    // Ada types 1200 in Bravo and presses Save.
    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    const [sent] = writesOf(bravo).map((call) => call.body);
    expect(sent, 'Bravo sent no threshold write').toBeDefined();
    expect(sent?.['operationId'], "Bravo's save carried Alpha's unanswered operation id").not.toBe(
      lost?.['operationId'],
    );
    expect(
      sent?.['expectedRevision'],
      "Bravo's save carried Alpha's revision, not the row Bravo just read",
    ).toBe(3);
  } finally {
    await page.unmount();
  }
});
