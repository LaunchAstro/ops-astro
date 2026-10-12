// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings General drawn again for another business keeps nothing of the
// first: a typed threshold is not one press from being saved into the second
// business, and a write outcome naming the first business's agent never shows
// there, even when its answer lands after the change.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SettingsGeneralScreen } from '../../apps/web/src/screens/SettingsGeneral.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- let each answer land
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

let held: (() => void) | undefined;

function business(key: string): OperationsClient {
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/session/capabilities')) {
      return Promise.resolve(
        json({
          ok: true,
          personId: 'p-ada',
          businessKey: key,
          grants: [
            { collection: 'settings', action: 'manage' },
            { collection: 'spend', action: 'decide' },
          ],
        }),
      );
    }
    if (at.endsWith('/settings/read')) return Promise.resolve(json({ ok: true, settings: [] }));
    if (at.endsWith('/agent/mine')) return Promise.resolve(json({ ok: true, agents: [] }));
    if (at.endsWith('/agent/create')) {
      return new Promise<Response>((resolve) => {
        held = () => resolve(json({ ok: true, recordId: null, detail: { agentId: 'a-new' } }));
      });
    }
    return Promise.resolve(json({ ok: true }));
  }) as typeof globalThis.fetch;
  return new OperationsClient({ origin: '', businessKey: key, signedIn: true, fetch });
}

const screen = (key: string) => (
  <SettingsGeneralScreen client={business(key)} grantKey={`${key}:ada:0`} storage={null} />
);

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  held = undefined;
});

it('a threshold typed for one business is gone when the screen is drawn for another', async () => {
  mounted = await mount(screen('alpha'));
  await tick();
  await mounted.type('#settings-four-eyes', '900');
  await mounted.render(screen('bravo'));
  await tick();
  expect((mounted.find('#settings-four-eyes') as HTMLInputElement | null)?.value ?? '').toBe('');
});

it('an agent made under one business is never announced under another, even when it lands late', async () => {
  mounted = await mount(screen('alpha'));
  await tick();
  await mounted.type('#agent-new-name', 'Alpha confidential planner');
  await mounted.click('[data-agent-new] button[type="submit"]');
  expect(held, 'the make was sent and its answer is held').toBeDefined();
  await mounted.render(screen('bravo'));
  await tick();
  held?.();
  await tick();
  expect(mounted.text()).not.toContain('Alpha confidential planner');
});
