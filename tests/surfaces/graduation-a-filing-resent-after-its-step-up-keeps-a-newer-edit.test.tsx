// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { GraduationRegion } from '../../apps/web/src/screens/connections/graduation.tsx';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { mount } from './mount.tsx';
import { fill, json, stubServer, tick, valueOf } from './graduation-draft-server.tsx';

const stepUp = () => Promise.resolve({ ok: true as const, sessionId: 'fresh' });

// The first filing is refused for a fresh sign-in; every later call reaches the stub.
const server = stubServer();
let attempts = 0;
const fetch: typeof globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/mandate/file') && attempts++ === 0) {
    return json({ refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: [] }, 403);
  }
  return await server.fetch(url, init);
};
const makeClient = () =>
  new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
const screen = () => (
  <StepUpContext.Provider value={stepUp}>
    <GraduationRegion client={makeClient()} grantKey="alpha:person-a" />
  </StepUpContext.Provider>
);

it('a filing resent once the new sign-in lands keeps a ceiling typed while it waited', async () => {
  const page = await mount(screen());
  try {
    await tick();
    await fill(page);
    await page.click('[data-mandate-add]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
    const field = page.host.querySelector<HTMLInputElement>('[data-mandate-ceiling]');
    const locked = field?.disabled === true;
    if (!locked) await page.type('[data-mandate-ceiling]', '750');
    expect(locked || valueOf(page, '[data-mandate-ceiling]') === '750').toBe(true);
    await page.type('[data-step-up="code"]', '123456');
    await page.click('[data-step-up="confirm"]');
    await tick();
    expect(attempts).toBe(1);
    const stillLocked =
      page.host.querySelector<HTMLInputElement>('[data-mandate-ceiling]')?.disabled === true;
    if (!stillLocked) await page.type('[data-mandate-ceiling]', '750');
    await act(async () => {
      await page.render(screen());
    });
    await tick();
    expect(attempts).toBe(2);
    expect(server.sent.find((one) => one.at.endsWith('/mandate/file'))?.body['ceiling']).toEqual({
      amountMinor: 50000,
      currency: 'AUD',
    });
    expect(
      stillLocked || valueOf(page, '[data-mandate-ceiling]') === '750',
      'A pending resend of the original $500 must not erase the newer $750 ceiling',
    ).toBe(true);
  } finally {
    await page.unmount();
  }
});
