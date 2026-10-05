// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The four-eyes threshold is money (#881). A person whose money sign-in went
// stale is asked for their authenticator code on the full settings page, as
// the planning cap asks; a good code moves the tab to the new sign-in and the
// held threshold is sent once, through the new sign-in's client.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpProviders } from '../../apps/web/src/records/step-up-providers.tsx';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import type { StepUpResult } from '../../apps/web/src/session/step-up.ts';
import { mount } from './mount.tsx';
import { fourEyesWorld, tick, writesOf, type FourEyesWorld } from './settings-four-eyes-world.tsx';

const signInAgain = (): Promise<StepUpResult> =>
  Promise.resolve({ ok: false, because: 'not used' });

/** The tab's two sign-ins over one API, and the codes the step-up was given. */
function signIns(world: FourEyesWorld) {
  const throughRefreshed: string[] = [];
  const refreshed = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: ((url: string | URL, init?: RequestInit) => {
      throughRefreshed.push(String(url));
      return world.fetch(url, init);
    }) as typeof globalThis.fetch,
  });
  const codes: string[] = [];
  const stepUp = (code: string): Promise<StepUpResult> => {
    codes.push(code);
    return Promise.resolve({ ok: true, sessionId: 'tab-two' });
  };
  const page = (client: OperationsClient) => (
    <StepUpProviders on stepUp={stepUp} signInAgain={signInAgain}>
      <SettingsScreen client={client} grantKey="alpha:ada:0" storage={window.sessionStorage} />
    </StepUpProviders>
  );
  return { first: world.client(), refreshed, throughRefreshed, codes, page };
}

it('a stale money sign-in completes the step-up and the four-eyes save it held', async () => {
  window.sessionStorage.clear();
  const world = fourEyesWorld({ value: 500, revision: 7 });
  const { first, refreshed, throughRefreshed, codes, page } = signIns(world);
  const view = await mount(page(first));
  try {
    await tick();
    world.write = 'step-up';
    await view.type('#settings-four-eyes', '1200');
    await view.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(
      view.find('[data-step-up="prompt"]'),
      'no code prompt for a stale money sign-in',
    ).not.toBeNull();

    await view.type('[data-step-up="code"]', '123456');
    await view.click('[data-step-up="confirm"]');
    await tick();
    // The application builds the new sign-in's client once the tab adopts it.
    await view.render(page(refreshed));
    await tick();

    expect(codes).toEqual(['123456']);
    expect(writesOf(world)).toHaveLength(2);
    expect(throughRefreshed.filter((at) => at.includes('/settings/set_'))).toHaveLength(1);
    expect(world.server().value).toBe(1200);
    expect(view.find('[data-step-up="prompt"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});
