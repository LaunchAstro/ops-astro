// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// One settings write is in flight at a time, but it is its owner's. Alpha's
// threshold save is still unanswered when the tab and the mounted Settings
// screen move to Bravo: Bravo's button does not claim a Bravo save is under
// way, and once Alpha answers, Bravo saves as usual.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { fourEyesWorld, tick, writesOf } from '../surfaces/settings-four-eyes-world.tsx';

const ALPHA: Session = { businessKey: 'alpha', email: 'ada@example.test' };
const BRAVO: Session = { businessKey: 'bravo', email: 'ada@example.test' };

/** Alpha's API, with its first threshold write held until the test answers it. */
function heldAlpha() {
  const world = fourEyesWorld({ value: 500, revision: 7 });
  const gate: { answer: (() => void) | null } = { answer: null };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: ((url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/settings/set_four_eyes_threshold')) return world.fetch(url, init);
      return new Promise<Response>((resolve) => {
        gate.answer = () => {
          void world.fetch(url, init).then(resolve);
        };
      });
    }) as typeof globalThis.fetch,
  });
  return { client, gate };
}

it("Alpha's unanswered save does not read as saving in Bravo, and Bravo saves once it answers", async () => {
  window.sessionStorage.clear();
  const sessions = new SessionStore(window.sessionStorage);
  const alpha = heldAlpha();
  const bravo = fourEyesWorld({ value: 800, revision: 3 });
  const screen = (client: OperationsClient) => (
    <SettingsScreen
      client={client}
      grantKey={grantKeyOf(sessions.session)}
      storage={window.sessionStorage}
    />
  );
  sessions.set(ALPHA);
  const view = await mount(screen(alpha.client));
  try {
    await tick();
    await view.type('#settings-four-eyes', '1200');
    await view.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(
      view.find('[data-settings="save-four-eyes"]')?.textContent,
      'Alpha shows its own save',
    ).toBe('Saving…');

    sessions.set(BRAVO);
    await view.render(screen(bravo.client('bravo')));
    await tick();
    const label = view.find('[data-settings="save-four-eyes"]')?.textContent;

    alpha.gate.answer?.();
    await tick();
    await view.type('#settings-four-eyes', '900');
    await view.click('[data-settings="save-four-eyes"]');
    await tick();
    expect({ label, bravo: writesOf(bravo).map((w) => w.body['value']) }).toEqual({
      label: 'Save threshold',
      bravo: [900],
    });
  } finally {
    await view.unmount();
  }
});
