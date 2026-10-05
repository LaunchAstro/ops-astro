// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A conflict is its business's. Alpha refuses Ada's threshold VERSION_STALE
// and the page shows the conflict, with its "write over it" press. Before she
// answers it, the tab and the still-mounted Settings screen move to Bravo:
// Bravo shows no conflict it never had, and nothing of Alpha's draft can be
// written over Bravo's threshold.

import { expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from '../surfaces/mount.tsx';
import { fourEyesWorld, tick, writesOf } from '../surfaces/settings-four-eyes-world.tsx';

const ALPHA: Session = { businessKey: 'alpha', email: 'ada@example.test' };
const BRAVO: Session = { businessKey: 'bravo', email: 'ada@example.test' };

it("Alpha's unanswered conflict is neither shown in Bravo nor written over Bravo's threshold", async () => {
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
    await view.type('#settings-four-eyes', '1200');
    await view.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(view.find('[data-settings="conflict"]'), 'Alpha shows its conflict').not.toBeNull();

    sessions.set(BRAVO);
    await view.render(screen(bravo.client('bravo')));
    await tick();
    const seen = {
      conflict: view.find('[data-settings="conflict"]')?.textContent ?? null,
      writeOver: view.find('[data-settings="confirm-four-eyes"]') !== null,
    };
    await view.click('[data-settings="confirm-four-eyes"]').catch(() => null);
    await tick();
    expect({ ...seen, writes: writesOf(bravo).length, server: bravo.server() }).toEqual({
      conflict: null,
      writeOver: false,
      writes: 0,
      server: { value: 800, revision: 3 },
    });
  } finally {
    await view.unmount();
  }
});
