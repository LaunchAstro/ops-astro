// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// What the screen says is about one business. In Alpha, a conflict whose
// reread failed holds Save and says why (#880). The tab and the still-mounted
// Settings screen then move to Bravo, whose read answered: Bravo is not told
// that somebody changed its settings.

import { expect, it } from 'vitest';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { fourEyesWorld, tick } from '../surfaces/settings-four-eyes-world.tsx';

const ALPHA: Session = { businessKey: 'alpha', email: 'ada@example.test' };
const BRAVO: Session = { businessKey: 'bravo', email: 'ada@example.test' };

it("Alpha's could-not-be-read-again hold is not said in Bravo", async () => {
  window.sessionStorage.clear();
  const sessions = new SessionStore(window.sessionStorage);
  const alpha = fourEyesWorld({ value: 500, revision: 7 });
  const bravo = fourEyesWorld({ value: 800, revision: 3 });
  const screen = (client: OperationsClient) => (
    <SettingsScreen
      client={client}
      grantKey={grantKeyOf(sessions.session)}
      storage={window.sessionStorage}
    />
  );
  sessions.set(ALPHA);
  const view = await mount(screen(alpha.client('alpha')));
  try {
    await tick();
    alpha.write = 'stale';
    alpha.read = 'read-fails';
    await view.type('#settings-four-eyes', '1200');
    await view.click('[data-settings="save-four-eyes"]');
    await tick();
    await view.click('[data-settings="save-four-eyes"]');
    await tick();
    const inAlpha = view.find('[data-settings="refusal"]')?.textContent ?? '';
    expect(inAlpha, 'Alpha says why Save is held').toContain('could not be read again');

    sessions.set(BRAVO);
    await view.render(screen(bravo.client('bravo')));
    await tick();
    expect(view.find('[data-settings="refusal"]')?.textContent ?? null).toBeNull();
  } finally {
    await view.unmount();
  }
});
