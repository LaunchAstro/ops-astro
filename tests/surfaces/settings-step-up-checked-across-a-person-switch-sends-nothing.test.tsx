// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The four-eyes threshold is money, and a person's own act. Ada's step-up code
// is still being checked when the tab, and the still-mounted Settings screen,
// move to Noah in the same business. The check passing then sends nothing: Ada's
// held threshold never goes out through Noah's sign-in.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpProviders } from '../../apps/web/src/records/step-up-providers.tsx';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import type { StepUpResult } from '../../apps/web/src/session/step-up.ts';
import { mount } from './mount.tsx';
import { fourEyesWorld, tick, type FourEyesWorld } from './settings-four-eyes-world.tsx';

const ADA: Session = { businessKey: 'alpha', email: 'ada@alpha.local' };
const NOAH: Session = { businessKey: 'alpha', email: 'noah@alpha.local' };

const signInAgain = (): Promise<StepUpResult> =>
  Promise.resolve({ ok: false, because: 'not used' });

/** One person's sign-in over the business's one API, and the writes it sent. */
function signedIn(world: FourEyesWorld) {
  const sent: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: ((url: string | URL, init?: RequestInit) => {
      sent.push(String(url));
      return world.fetch(url, init);
    }) as typeof globalThis.fetch,
  });
  return { client, writes: () => sent.filter((at) => at.includes('/settings/set_')) };
}

/** A step-up whose check answers only when the test passes it. */
function heldStepUp() {
  const check: { pass: ((result: StepUpResult) => void) | null } = { pass: null };
  const stepUp = (): Promise<StepUpResult> =>
    new Promise((resolve) => {
      check.pass = resolve;
    });
  const page = (client: OperationsClient, session: Session) => (
    <StepUpProviders on stepUp={stepUp} signInAgain={signInAgain}>
      <SettingsScreen
        client={client}
        grantKey={grantKeyOf(session)}
        storage={window.sessionStorage}
      />
    </StepUpProviders>
  );
  return { check, page };
}

it("Ada's step-up passing after the tab moved to Noah sends nothing through Noah's sign-in", async () => {
  window.sessionStorage.clear();
  const sessions = new SessionStore(window.sessionStorage);
  const world = fourEyesWorld({ value: 500, revision: 7 });
  const ada = signedIn(world);
  const noah = signedIn(world);
  const { check, page } = heldStepUp();

  sessions.set(ADA);
  const view = await mount(page(ada.client, ADA));
  try {
    await tick();
    world.write = 'step-up';
    await view.type('#settings-four-eyes', '1200');
    await view.click('[data-settings="save-four-eyes"]');
    await tick();
    await view.type('[data-step-up="code"]', '123456');
    await view.click('[data-step-up="confirm"]');
    await tick();
    expect(check.pass, "Ada's code is not being checked").not.toBeNull();

    // While the code is checked, the tab and the same screen move to Noah.
    sessions.set(NOAH);
    await view.render(page(noah.client, NOAH));
    await tick();
    check.pass?.({ ok: true, sessionId: 'ada-stepped-up' });
    await tick();

    expect({
      ada: ada.writes().length,
      noah: noah.writes(),
      threshold: world.server().value,
      prompt: view.find('[data-step-up="prompt"]'),
    }).toEqual({ ada: 1, noah: [], threshold: 500, prompt: null });
  } finally {
    await view.unmount();
  }
});
